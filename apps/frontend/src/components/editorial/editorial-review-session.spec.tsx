import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetcher = vi.fn();
vi.mock('@postmill-ai/helpers/utils/custom.fetch', () => ({
  useFetch: () => fetcher,
}));

import { EditorialReviewSession } from './editorial-review-session';

const postId = 'a'.repeat(32);
const taskId = '42';
const path = '/editorial/review/' + postId + '/' + taskId;
const commandId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const accepted = {
  status: 'queued/unconfirmed', event_id: eventId,
  publishable: false, dispatch_authorized: false,
};
let seq = '0';
let failRead = false;
let failPost = false;
function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body,
  } as Response;
}
const current = () => ({
  post_id: postId, task_id: taskId,
  content: { title: 'Тестовая история', parts: ['Первая', 'Вторая', 'Третья'] },
  review_acknowledged: true,
  review: { status: 'idle', last_confirmed_state: { seq, image_mode: 'disabled' } },
  remote_current_verified: false,
  publishable: false, dispatch_authorized: false,
});

describe('Editorial 06B-4C unmounted session owner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    seq = '0';
    failRead = false;
    failPost = false;
    vi.stubGlobal('crypto', { randomUUID: () => commandId });
    window.history.replaceState({}, '', '/');
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === path && options?.method === 'GET') {
        if (failRead) throw new Error('read unavailable');
        return response(current());
      }
      if (url === path + '/decisions' && options?.method === 'POST') {
        if (failPost) throw new Error('unknown outcome');
        return response(accepted);
      }
      throw new Error('unexpected request');
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, '', '/');
  });

  it('has no network activity when disabled', () => {
    render(<EditorialReviewSession postId={postId} taskId={taskId} enabled={false} />);
    expect(screen.getByText(/Редакторский обмен отключён/)).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('loads read-only snapshot, posts only on explicit editor action', async () => {
    render(<EditorialReviewSession postId={postId} taskId={taskId} enabled />);
    await screen.findByText('Тестовая история');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(path, { method: 'GET', cache: 'no-store' });
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenLastCalledWith(path + '/decisions', {
      method: 'POST', cache: 'no-store',
      body: JSON.stringify({
        command_id: commandId, expected_seq: '0', action: 'approve_text', feedback: '',
      }),
    });
    await screen.findByText(/Решение поставлено в очередь/);
  });

  it('keeps unknown POST blocked even after failed GET and restored same-sequence GET', async () => {
    failPost = true;
    render(<EditorialReviewSession postId={postId} taskId={taskId} enabled />);
    await screen.findByText('Тестовая история');
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    await screen.findByText(/Результат отправки неизвестен/);
    failRead = true;
    fireEvent.click(screen.getByRole('button', { name: /Проверить статус/ }));
    await screen.findByText(/Не удалось подтвердить актуальное состояние/);
    failRead = false;
    fireEvent.click(screen.getByRole('button', { name: /Проверить статус/ }));
    await screen.findByText('Тестовая история');
    expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled)
      .toBe(true);
    const posts = fetcher.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
  });

  it('unlocks only when new confirmed sequence is read', async () => {
    render(<EditorialReviewSession postId={postId} taskId={taskId} enabled />);
    await screen.findByText('Тестовая история');
    fireEvent.click(screen.getByRole('button', { name: 'Утвердить текст' }));
    await screen.findByText(/Решение поставлено в очередь/);
    seq = '1';
    fireEvent.click(screen.getByRole('button', { name: /Проверить статус/ }));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Утвердить текст' }) as HTMLButtonElement).disabled)
        .toBe(false));
  });

  it('refuses mismatch between requested and returned task identity', async () => {
    fetcher.mockImplementationOnce(async () => response({ ...current(), task_id: '99' }));
    render(<EditorialReviewSession postId={postId} taskId={taskId} enabled />);
    await screen.findByText(/Не удалось подтвердить актуальное состояние/);
    expect(screen.queryByRole('button', { name: 'Утвердить текст' })).toBeNull();
  });
});
