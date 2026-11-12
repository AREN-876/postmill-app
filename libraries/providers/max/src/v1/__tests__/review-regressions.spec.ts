import { beforeEach, describe, expect, it } from 'vitest';
import { MaxProvider } from '../social.adapter';
import { bot, chat, chatId, member, post, sent, token } from './fixtures';
import { installTransport, response, timer, wire } from './transport';

let provider: MaxProvider;
const credentials = { client_id: token, client_secret: '', instanceUrl: '' };
const channelChecks = (membership = member) =>
  wire
    .mockResolvedValueOnce(response(bot))
    .mockResolvedValueOnce(response(chat))
    .mockResolvedValueOnce(response(membership));
beforeEach(() => {
  installTransport();
  provider = new MaxProvider();
});

describe('PR #2 permission compatibility', () => {
  it.each(['write', 'post_edit_delete_message'])(
    'accepts admin permission %s for connection and posting',
    async (permission) => {
      const membership = { ...member, permissions: [permission] };
      channelChecks(membership);
      await expect(
        provider.authenticate({ code: chatId, codeVerifier: '' }, credentials),
      ).resolves.toHaveProperty('id', chatId);
      channelChecks(membership);
      wire.mockResolvedValueOnce(response(sent));
      await expect(provider.post(chatId, token, [post])).resolves.toHaveLength(
        1,
      );
    },
  );
  it.each([
    { ...member, permissions: ['read_all_messages'] },
    { ...member, permissions: [] },
    { ...member, permissions: ['write'], is_admin: false },
  ])('rejects insufficient permissions %# before POST', async (membership) => {
    channelChecks(membership);
    await expect(
      provider.authenticate({ code: chatId, codeVerifier: '' }, credentials),
    ).rejects.toMatchObject({
      message: expect.stringContaining('posting rights'),
    });
    channelChecks(membership);
    await expect(provider.post(chatId, token, [post])).rejects.toThrow(
      'posting rights',
    );
    expect(wire.mock.calls.every(([, init]) => init.method === 'GET')).toBe(
      true,
    );
  });
});

describe('PR #2 no automatic resend of MAX messages', () => {
  it.each([429, 500, 502, 503, 504])(
    'attempts POST exactly once on HTTP %i',
    async (status) => {
      channelChecks();
      wire.mockImplementation(async () => response({ message: token }, status));
      const error = await provider.post(chatId, token, [post]).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Automatic resend is disabled');
      expect(JSON.stringify(error)).not.toContain(token);
      expect(
        wire.mock.calls.filter(([, init]) => init.method === 'POST'),
      ).toHaveLength(1);
      expect(timer).not.toHaveBeenCalled();
      const init = wire.mock.calls.find(
        ([, options]) => options.method === 'POST',
      )![1];
      expect(init.redirect).toBe('error');
      expect(init).not.toHaveProperty('retryPolicy');
    },
  );
  it('does not retry a POST whose error body mentions rate limits', async () => {
    channelChecks();
    wire.mockResolvedValue(response({ message: 'rate_limit_exceeded' }, 400));
    await expect(provider.post(chatId, token, [post])).rejects.toThrow();
    expect(
      wire.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(1);
    expect(timer).not.toHaveBeenCalled();
  });
  it.each([
    'timeout',
    'connection reset',
    'invalid JSON',
    'missing message id',
  ])('does not resend after an ambiguous %s', async (failure) => {
    channelChecks();
    if (failure === 'invalid JSON')
      wire.mockResolvedValueOnce(new Response('not json'));
    else if (failure === 'missing message id')
      wire.mockResolvedValueOnce(response({ message: {} }));
    else
      wire.mockRejectedValueOnce(
        Object.assign(new Error(token), {
          name: failure === 'timeout' ? 'TimeoutError' : 'Error',
        }),
      );
    const error = await provider.post(chatId, token, [post]).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Automatic resend is disabled');
    expect(JSON.stringify(error)).not.toContain(token);
    expect(
      wire.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(1);
    expect(timer).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])(
    'still retries a read-only GET on HTTP %i and then sends one POST',
    async (status) => {
      wire.mockResolvedValueOnce(response({}, status));
      channelChecks();
      wire.mockResolvedValueOnce(response(sent));
      await expect(provider.post(chatId, token, [post])).resolves.toHaveLength(
        1,
      );
      expect(
        wire.mock.calls.filter(
          ([url]) => url.endsWith('/me') && !url.includes('/members'),
        ),
      ).toHaveLength(2);
      expect(
        wire.mock.calls.filter(([, init]) => init.method === 'POST'),
      ).toHaveLength(1);
      expect(timer).toHaveBeenCalledTimes(1);
    },
  );
});
