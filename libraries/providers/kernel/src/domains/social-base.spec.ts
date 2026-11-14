import { describe, it, expect, vi } from 'vitest';
import { SocialAbstract, setSocialFetchPorts } from './social-base';

class TestProvider extends SocialAbstract {
  identifier = 'test';
}

class TestBadBodyError extends Error {
  constructor(
    public identifier: string,
    public json: string,
    public body: any,
    message: string
  ) {
    super(message);
  }
}

function setPorts(undiciFetch: any) {
  setSocialFetchPorts({
    getVpnDispatcher: () => undefined,
    ssrfSafeDispatcher: undefined,
    isSafePublicHttpsUrl: async () => true,
    undiciFetch,
    RefreshTokenError: class RefreshTokenError extends Error {} as any,
    BadBodyError: TestBadBodyError as any,
    timer: async () => undefined,
    sharp: undefined,
    readOrFetch: async () => Buffer.from(''),
    safeFetch: vi.fn() as any,
  });
}

describe('SocialAbstract.fetch', () => {
  it.each([200, 201, 202, 204])('treats HTTP %i as success', async (status) => {
    setPorts(
      vi.fn(async () => new Response(status === 204 ? null : '{}', { status }))
    );
    const result = await new TestProvider().fetch('https://api.example.com/x');
    expect(result.status).toBe(status);
  });

  it('still rejects non-2xx with BadBodyError', async () => {
    setPorts(
      vi.fn(
        async () => new Response('{"error":"nope"}', { status: 400 })
      )
    );
    await expect(
      new TestProvider().fetch('https://api.example.com/x')
    ).rejects.toBeInstanceOf(TestBadBodyError);
  });
});

// The opt-out is request-local. Existing providers retain their retry behavior,
// while unsafe writes can reuse the same SSRF/VPN/timeout path without resends.
describe('SocialAbstract per-request retry policy', () => {
  it.each([429, 500])('keeps default POST retries on HTTP %i', async status => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status })).mockResolvedValueOnce(new Response('{}'));
    setPorts(fetch);
    await expect(new TestProvider().fetch('https://api.example.com/x', { method: 'POST' })).resolves.toHaveProperty('status', 200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([429, 500, 503])('opts out of all retry branches on HTTP %i', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"error":"Rate limit rate_limit_exceeded"}', { status }));
    setPorts(fetch);
    const provider = new TestProvider();
    vi.spyOn(provider, 'handleErrors').mockReturnValue({ type: 'retry', value: 'Temporary failure' });
    await expect(provider.fetch('https://api.example.com/x', { method: 'POST', retryPolicy: 'none' })).rejects.toBeInstanceOf(TestBadBodyError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('retryPolicy');
  });
  it('does not leak an opt-out into a later default request on the same adapter', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValueOnce(new Response('{}'));
    setPorts(fetch);
    const provider = new TestProvider();
    await expect(provider.fetch('https://api.example.com/x', { method: 'POST', retryPolicy: 'none' })).rejects.toBeInstanceOf(TestBadBodyError);
    await expect(provider.fetch('https://api.example.com/x')).resolves.toHaveProperty('status', 200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
