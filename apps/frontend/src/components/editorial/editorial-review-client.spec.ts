import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorialReviewClient } from './editorial-review-client';
import type { EditorialHumanCommand } from './editorial-review-panel';

const postId = 'a'.repeat(32);
const taskId = '42';
const path = '/editorial/review/' + postId + '/' + taskId;
const eventId = '22222222-2222-4222-8222-222222222222';
const command: EditorialHumanCommand = {
  command_id: '11111111-1111-4111-8111-111111111111',
  expected_seq: '0', action: 'approve_text', feedback: '',
};
const snapshot = {
  post_id: postId, task_id: taskId,
  content: { title: 'Тест', parts: ['Часть А', 'Часть Б', 'Часть В'] },
  review_acknowledged: true,
  review: { status: 'idle', last_confirmed_state: { seq: '0', image_mode: 'disabled' } },
  remote_current_verified: false, dispatch_authorized: false, publishable: false,
};
const accepted = {
  status: 'queued/unconfirmed', event_id: eventId,
  dispatch_authorized: false, publishable: false,
};
function reply(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => data,
  } as Response;
}

describe('Editorial 06B-4C narrow session review client', () => {
  const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();
  const api = editorialReviewClient(fetcher);
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => { window.history.replaceState({}, '', '/'); });

  it('GET uses only exact bound ids and returns server-verified three-part data', async () => {
    fetcher.mockResolvedValueOnce(reply(snapshot));
    const data = await api.read(postId, taskId);
    expect(data).toMatchObject(snapshot);
    expect(fetcher).toHaveBeenCalledWith(path, { method: 'GET', cache: 'no-store' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses invalid identifiers and loggedAuth header fallback before HTTP', async () => {
    await expect(api.read('not-an-id', taskId)).rejects.toThrow('editorial_invalid_identity');
    await expect(api.read(postId, '9223372036854775808'))
      .rejects.toThrow('editorial_invalid_identity');
    window.history.replaceState({}, '', '/?loggedAuth=public-key');
    await expect(api.read(postId, taskId)).rejects.toThrow('editorial_cookie_session_required');
    await expect(api.queue(postId, taskId, command)).rejects.toThrow('editorial_cookie_session_required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses wrong receipt identities and unsafe/partial snapshots', async () => {
    for (const data of [
      { ...snapshot, task_id: '99' },
      { ...snapshot, content: { title: 'Тест', parts: ['1', '2'] } },
      { ...snapshot, publishable: true },
      { ...snapshot, review_acknowledged: false },
      { ...snapshot, review: { status: 'idle', last_confirmed_state: { seq: '9223372036854775808' } } },
    ]) {
      fetcher.mockResolvedValueOnce(reply(data));
      await expect(api.read(postId, taskId)).rejects.toThrow('editorial_untrusted_snapshot');
    }
  });

  it('queue transmits exactly the supported four fields once, never approval', async () => {
    fetcher.mockResolvedValueOnce(reply(accepted));
    const result = await api.queue(postId, taskId, command);
    expect(result).toEqual({
      status: 'queued/unconfirmed', publishable: false, dispatch_authorized: false,
    });
    expect(fetcher).toHaveBeenCalledWith(path + '/decisions', {
      method: 'POST', cache: 'no-store', body: JSON.stringify(command),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects extra claimed actor/org and non-text feedback before network', async () => {
    await expect(api.queue(postId, taskId, {
      ...command, actor_id: 'owner',
    } as EditorialHumanCommand)).rejects.toThrow('editorial_invalid_command');
    await expect(api.queue(postId, taskId, {
      ...command, action: 'request_text_changes', feedback: '  ',
    })).rejects.toThrow('editorial_invalid_command');
    await expect(api.queue(postId, taskId, {
      ...command, feedback: 'unwanted',
    })).rejects.toThrow('editorial_invalid_command');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never retries unknown POST failures or trusts malformed response', async () => {
    fetcher.mockRejectedValueOnce(new Error('timeout'));
    await expect(api.queue(postId, taskId, command)).rejects.toThrow('timeout');
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(reply({ ...accepted, publishable: true }));
    await expect(api.queue(postId, taskId, command)).rejects.toThrow('editorial_queue_outcome_unknown');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
