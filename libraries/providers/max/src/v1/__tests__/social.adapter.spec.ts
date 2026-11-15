import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MaxProvider, maxSocialModule } from '../social.adapter';
import { isProviderVerified } from '@postmill-ai/provider-kernel';
import { bot, chat, chatId, member, post, sent, token } from './fixtures';
import { installTransport, response, timer, wire } from './transport';

const creds = { client_id: token, client_secret: '', instanceUrl: '' };
const params = { code: chatId, codeVerifier: '' };
const checks = () =>
  wire
    .mockResolvedValueOnce(response(bot))
    .mockResolvedValueOnce(response(chat))
    .mockResolvedValueOnce(response(member));
let provider: MaxProvider;
beforeEach(() => {
  installTransport();
  provider = new MaxProvider();
});

describe('MAX credentials and channel checks', () => {
  it('advertises only text and remains unverified without a live sandbox', () => {
    expect(maxSocialModule.manifest.capabilities).toMatchObject({
      maxMedia: 0,
      analytics: false,
      comments: false,
      refreshToken: false,
    });
    expect(isProviderVerified('social', 'max')).toBe(false);
    expect(provider.setupDescriptor.authType).toBe('token');
    expect(provider.maxLength()).toBe(4000);
  });
  it('mints a fresh nonce without network calls', async () => {
    const a = await provider.generateAuthUrl();
    const b = await provider.generateAuthUrl();
    expect(a.state).not.toBe(b.state);
    expect(a.state.length).toBeGreaterThanOrEqual(32);
    expect(a.codeVerifier).toBeTruthy();
    expect(wire).not.toHaveBeenCalled();
  });
  it('preserves a full-width int64 from a raw numeric API reply', async () => {
    wire.mockResolvedValueOnce(response(bot)).mockResolvedValueOnce(new Response('{"chat_id":9223372036854775807,"type":"channel","status":"active","title":"Wide ID"}')).mockResolvedValueOnce(response(member));
    expect(await provider.authenticate({ code: '9223372036854775807', codeVerifier: '' }, creds)).toMatchObject({ id: 'max:9223372036854775807', rootId: '9223372036854775807' });
  });
  it('validates bot, active channel and explicit posting permission without writing', async () => {
    checks();
    expect(await provider.authenticate(params, creds)).toMatchObject({
      id: `max:${chatId}`,
      name: chat.title,
      accessToken: token,
    });
    expect(wire.mock.calls.map(([url]) => url)).toEqual([
      'https://platform-api2.max.ru/me',
      `https://platform-api2.max.ru/chats/${chatId}`,
      `https://platform-api2.max.ru/chats/${chatId}/members/me`,
    ]);
    for (const [url, init] of wire.mock.calls) {
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe(token);
      expect(url).not.toContain(token);
      expect(init.dispatcher).toEqual({ synthetic: true });
    }
  });
  it.each([
    '',
    '0',
    'channel',
    '1?token=secret',
    '1/../me',
    '9223372036854775808',
  ])('rejects invalid chat id %s before HTTP', async (id) => {
    await expect(
      provider.authenticate({ ...params, code: id }, creds),
    ).rejects.toThrow('chat_id');
    expect(wire).not.toHaveBeenCalled();
  });
  it.each([undefined, '', ' ', 'token\nheader'])(
    'rejects missing/unsafe token before HTTP',
    async (value) => {
      await expect(
        provider.authenticate(params, { ...creds, client_id: value as string }),
      ).rejects.toThrow('token');
      expect(wire).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...chat, type: 'dialog' },
    { ...chat, status: 'left' },
    { ...chat, chat_id: -999 },
    {},
    { ...chat, chat_id: 9007199254740992 },
  ])('rejects an invalid target %#', async (target) => {
    wire
      .mockResolvedValueOnce(response(bot))
      .mockResolvedValueOnce(response(target));
    await expect(provider.authenticate(params, creds)).rejects.toThrow(
      'active channel',
    );
  });
  it.each([
    { ...member, is_admin: false },
    { ...member, permissions: null },
    { ...member, permissions: ['read_all_messages'] },
    { ...member, user_id: 99 },
  ])('fails closed on insufficient membership %#', async (membership) => {
    wire
      .mockResolvedValueOnce(response(bot))
      .mockResolvedValueOnce(response(chat))
      .mockResolvedValueOnce(response(membership));
    await expect(provider.authenticate(params, creds)).rejects.toThrow(
      'posting rights',
    );
  });
  it('accepts a matching owner', async () => {
    wire
      .mockResolvedValueOnce(response(bot))
      .mockResolvedValueOnce(response(chat))
      .mockResolvedValueOnce(
        response({ ...member, is_owner: true, permissions: null }),
      );
    await expect(provider.authenticate(params, creds)).resolves.toHaveProperty(
      'id',
      `max:${chatId}`,
    );
  });
  it('rejects non-bot identity', async () => {
    wire.mockResolvedValueOnce(response({ ...bot, is_bot: false }));
    await expect(provider.authenticate(params, creds)).rejects.toThrow(
      'unexpected response',
    );
  });
  it('does not silently rotate a static token', async () => {
    await expect(provider.refreshToken()).rejects.toThrow('Reconnect');
    expect(wire).not.toHaveBeenCalled();
  });
});

describe('MAX text posting and errors (synthetic HTTP only)', () => {
  it.each([4000, 3999])(
    'posts %i characters intact and maps ids and public URL',
    async (size) => {
      checks();
      wire.mockResolvedValueOnce(response(sent));
      const text = 'x'.repeat(size);
      expect(
        await provider.post(chatId, token, [{ ...post, message: text }]),
      ).toEqual([
        {
          id: post.id,
          postId: 'synthetic-mid',
          releaseURL: sent.message.url,
          status: 'completed',
        },
      ]);
      const [url, init] = wire.mock.calls[3];
      expect(url).toBe(
        `https://platform-api2.max.ru/messages?chat_id=${chatId}&disable_link_preview=true`,
      );
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ text });
      expect(init.headers.Authorization).toBe(token);
    },
  );
  it.each(['', ' ', 'x'.repeat(4001)])(
    'rejects empty/oversize text %#',
    async (text) => {
      await expect(
        provider.post(chatId, token, [{ ...post, message: text }]),
      ).rejects.toThrow('1–4000');
      expect(wire).not.toHaveBeenCalled();
    },
  );
  it.each([
    { media: [{ type: 'image', path: 'not-fetched' }] },
    { poll: { options: ['a', 'b'], duration: 1 } },
    { firstComment: 'comment' },
    { settings: { firstComment: 'comment' } },
  ])('rejects unsupported payload %# before any HTTP', async (extra) => {
    await expect(
      provider.post(chatId, token, [{ ...post, ...extra } as any]),
    ).rejects.toThrow('text only');
    expect(wire).not.toHaveBeenCalled();
  });
  it('rejects threads and media in server validation', async () => {
    expect(await provider.checkValidity([[], []])).toMatch('threads');
    expect(await provider.checkValidity([[{ path: 'image.png' }]])).toMatch(
      'text only',
    );
    expect(await provider.checkValidity([[]])).toBe(true);
    await expect(provider.post(chatId, token, [post, post])).rejects.toThrow(
      'exactly one',
    );
    expect(wire).not.toHaveBeenCalled();
  });
  it('does not send text if rights are revoked', async () => {
    wire
      .mockResolvedValueOnce(response(bot))
      .mockResolvedValueOnce(response(chat))
      .mockResolvedValueOnce(response({ ...member, permissions: [] }));
    await expect(provider.post(chatId, token, [post])).rejects.toThrow(
      'posting rights',
    );
    expect(wire.mock.calls.every(([, init]) => init.method === 'GET')).toBe(
      true,
    );
  });
  it.each([
    {},
    { message: {} },
    { message: { body: { mid: 12 } } },
    { error: token },
    { code: 'error', message: token },
  ])('rejects malformed success response %#', async (data) => {
    checks();
    wire.mockResolvedValueOnce(response(data));
    await expect(provider.post(chatId, token, [post])).rejects.toThrow(
      'not confirmed',
    );
  });
  it.each([
    undefined,
    'javascript:alert(1)',
    'https://attacker.invalid/post',
    'https://user:pass@max.ru/post',
  ])('never invents or trusts an unsafe public URL %#', async (url) => {
    checks();
    wire.mockResolvedValueOnce(response({ message: { ...sent.message, url } }));
    expect((await provider.post(chatId, token, [post]))[0].releaseURL).toBe('');
  });
  it.each([
    [401, 'token'],
    [403, 'posting rights'],
    [400, 'request'],
    [429, 'rate limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])(
    'handles HTTP %i with sanitized errors and bounded retries',
    async (status, reason) => {
      const logs = vi.spyOn(console, 'error');
      wire.mockImplementation(async () =>
        response({ message: token }, status as number),
      );
      const error = await provider.authenticate(params, creds).catch((e) => e);
      expect(error.message).toContain(reason);
      expect(JSON.stringify(error)).not.toContain(token);
      expect(String(error.stack)).not.toContain(token);
      expect(logs).not.toHaveBeenCalled();
      expect(wire).toHaveBeenCalledTimes(
        Number(status) >= 500 || status === 429 ? 4 : 1,
      );
      logs.mockRestore();
    },
  );
  it.each([401, 403, 429, 500, 503])('handles publish HTTP %i without returning a completed post or leaking the token', async status => {
    checks(); wire.mockImplementation(async () => response({ message: token }, status));
    const error = await provider.post(chatId, token, [post]).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(String(error.stack)).not.toContain(token);
    expect(wire.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  });

  it('uses the shared retry path and recovers from rate limiting', async () => {
    wire.mockResolvedValueOnce(response({}, 429));
    checks();
    await expect(provider.authenticate(params, creds)).resolves.toHaveProperty(
      'id',
      `max:${chatId}`,
    );
    expect(timer).toHaveBeenCalledWith(5000);
  });
  it('sanitizes malformed JSON and token-echoing transport failures', async () => {
    wire.mockRejectedValueOnce(new Error(`Authorization: ${token}`));
    const error = await provider.authenticate(params, creds).catch((e) => e);
    expect(error.message).toContain('connectivity');
    expect(JSON.stringify(error)).not.toContain(token);
    wire.mockResolvedValueOnce(new Response('not json'));
    await expect(provider.authenticate(params, creds)).rejects.toThrow(
      'unexpected response',
    );
  });
});
