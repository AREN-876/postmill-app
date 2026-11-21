import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorialReleaseControls } from './editorial-release-controls';
import { canOfferEditorialRelease, editorialReleaseClient } from './editorial-release-client';
import type { EditorialReviewSnapshot } from './editorial-review-panel';

const postId = 'a'.repeat(32);
const taskId = '804';
const commandId = '11111111-1111-4111-8111-111111111111';
const publicationId = 'b'.repeat(32);
const path = `/editorial/release/${postId}/${taskId}`;
const slot = {
  integrationId: 'ci-max', timezone: 'Europe/Moscow',
  localTime: '2026-11-22 08:00', publishAt: '2026-11-22T05:00:00.000Z',
};
const preview = { ready: true, status: 'available', next_slot: slot };
const accepted = {
  created: true, status: 'native_dispatch_requested',
  source_post_id: postId, publication_post_id: publicationId,
  mode: 'publish_now', publish_at: '2026-11-21T10:00:00.000Z',
  max_delivery_confirmed: false,
};
const fetcher = vi.fn<(url: string, options?: RequestInit) => Promise<Response>>();
const attempted = vi.fn();

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}
function snapshot(approved = true): EditorialReviewSnapshot {
  return {
    post_id: postId, task_id: taskId,
    content: { title: 'История', parts: ['Один', 'Два', 'Три'] },
    review_acknowledged: true,
    review: {
      status: 'idle',
      last_confirmed_state: {
        seq: '1', text_status: approved ? 'approved' : 'pending',
        final_approved: approved, rejected: false, image_mode: 'disabled',
      },
    },
    remote_current_verified: false,
    publishable: false, dispatch_authorized: false,
  };
}
function show(approved = true) {
  return render(<EditorialReleaseControls
    postId={postId} taskId={taskId} snapshot={snapshot(approved)}
    fetcher={fetcher} mutationsBlocked={false} onReleaseAttempt={attempted}
  />);
}

describe('Editorial 09B: explicit whole-story release controls', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('crypto', { randomUUID: () => commandId });
    window.history.replaceState({}, '', '/');
    fetcher.mockImplementation(async (_url, options) =>
      response(options?.method === 'POST' ? accepted : preview));
  });

  it('offers no release before final approval and performs no HTTP requests', () => {
    expect(canOfferEditorialRelease(snapshot(false))).toBe(false);
    show(false);
    expect(screen.queryByRole('button', { name: 'Опубликовать сейчас' })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('only GETs a Moscow slot on mount; review approval alone sends no release', async () => {
    show();
    await screen.findByText(/2026-11-22 08:00 МСК/);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(attempted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Опубликовать сейчас' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Добавить в очередь' })).toBeTruthy();
  });

  it('publish-now requires two explicit clicks and dispatches one native story POST', async () => {
    show();
    const publish = await screen.findByRole('button', { name: 'Опубликовать сейчас' });
    fireEvent.click(publish);
    expect(attempted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить выпуск' }));
    await waitFor(() => expect(attempted).toHaveBeenCalledTimes(1));
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual([path, {
      method: 'POST', cache: 'no-store',
      body: JSON.stringify({ command_id: commandId, action: 'publish_now', publish_at: null }),
    }]);
    await screen.findByText(/Доставка в MAX ещё не подтверждена/);
  });

  it('queue uses exactly one 08:00 Moscow slot for all three parts', async () => {
    fetcher.mockImplementation(async (_url, options) => response(
      options?.method === 'POST' ? {
        ...accepted, mode: 'queue', publish_at: slot.publishAt,
      } : preview
    ));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Добавить в очередь' }));
    expect(screen.getByText(/Подтверди выпуск всех трёх частей 2026-11-22 08:00 МСК/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить выпуск' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) =>
      url === path && options?.method === 'POST' &&
      JSON.parse(String(options.body)).publish_at === slot.publishAt
    )).toBe(true));
  });

  it('unknown POST response is never automatically resent', async () => {
    fetcher.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') throw new Error('timeout');
      return response(preview);
    });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Опубликовать сейчас' }));
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить выпуск' }));
    await screen.findByText(/Результат выпуска неизвестен/);
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    expect(attempted).toHaveBeenCalledTimes(1);
  });

  it('HTTP client rejects loggedAuth fallback, malformed slot or extra request fields', async () => {
    const client = editorialReleaseClient(fetcher);
    fetcher.mockResolvedValueOnce(response({ ...preview, next_slot: {
      ...slot, timezone: 'browser-local',
    } }));
    await expect(client.preview(postId, taskId)).rejects.toThrow('editorial_release_preview_untrusted');
    await expect(client.submit(postId, taskId, {
      command_id: commandId, action: 'publish_now', publish_at: null,
      actor_id: 'forged',
    } as any)).rejects.toThrow('editorial_release_invalid');
    window.history.replaceState({}, '', '/?loggedAuth=unsafe');
    await expect(client.preview(postId, taskId)).rejects.toThrow('editorial_cookie_session_required');
  });
});
