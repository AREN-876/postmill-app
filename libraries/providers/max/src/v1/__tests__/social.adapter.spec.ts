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

describe('MAX post analytics (synthetic GET only)', () => {
  const mid = 'mid.ffffbd8f0123abc';
  const message = (views: unknown, recipient: unknown = { chat_id: chat.chat_id }) => ({
    recipient,
    body: { mid },
    stat: { views },
  });

  it('reads cumulative views for exactly the selected MAX channel', async () => {
    wire.mockResolvedValueOnce(response({ messages: [message(42)] }));
    const result = await provider.postAnalytics(`max:${chatId}`, token, mid, 2);
    expect(result).toEqual([{
      label: 'Views',
      data: [{ total: '42', date: new Date().toISOString().slice(0, 10) }],
    }]);
    expect(wire).toHaveBeenCalledTimes(1);
    const [url, init] = wire.mock.calls[0];
    expect(url).toBe(`https://platform-api2.max.ru/messages?message_ids=${mid}`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(token);
    expect(url).not.toContain(token);
    expect(init.dispatcher).toEqual({ synthetic: true });
  });

  it('preserves zero as a measured value, not absent data', async () => {
    wire.mockResolvedValueOnce(response({ messages: [message(0)] }));
    expect(await provider.postAnalytics(chatId, token, mid, 2)).toMatchObject([
      { label: 'Views', data: [{ total: '0' }] },
    ]);
  });

  it.each([
    { stat: null },
    {},
    { stat: { views: null } },
    { stat: { views: -1 } },
    { stat: { views: '4' } },
    { stat: { views: 1.4 } },
    { stat: { views: 9007199254740992 } },
  ])('does not fabricate a value for missing or unsafe stats %#', async (fields) => {
    wire.mockResolvedValueOnce(response({
      messages: [{ recipient: { chat_id: chat.chat_id }, body: { mid }, ...fields }],
    }));
    expect(await provider.postAnalytics(chatId, token, mid, 2)).toEqual([]);
  });

  it.each([
    { recipient: { chat_id: 999999 }, body: { mid }, stat: { views: 80 } },
    { recipient: null, body: { mid }, stat: { views: 80 } },
    { recipient: { chat_id: chat.chat_id }, body: { mid: 'mid.other' }, stat: { views: 80 } },
  ])('does not accept an unrelated channel or MID %#', async (received) => {
    wire.mockResolvedValueOnce(response({ messages: [received] }));
    expect(await provider.postAnalytics(chatId, token, mid, 2)).toEqual([]);
  });

  it('handles full-width MAX int64 channel IDs without Number rounding', async () => {
    wire.mockResolvedValueOnce(new Response(
      '{"messages":[{"recipient":{"chat_id":9223372036854775807},"body":{"mid":"mid.ffffbd8f0123abc"},"stat":{"views":8}}]}',
    ));
    expect(await provider.postAnalytics('max:9223372036854775807', token, mid, 2)).toMatchObject([
      { label: 'Views', data: [{ total: '8' }] },
    ]);
  });

  it.each(['', 'mid.a,mid.b', 'a/b', '?anything', 'x'.repeat(201)])(
    'rejects unsafe or ambiguous MID %# before HTTP',
    async invalid => {
      expect(await provider.postAnalytics(chatId, token, invalid, 2)).toEqual([]);
      expect(wire).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed response envelopes without recording a metric', async () => {
    wire.mockResolvedValueOnce(response({ messages: null }));
    await expect(provider.postAnalytics(chatId, token, mid, 2)).rejects.toThrow(
      'unexpected response',
    );
  });

  it('rejects invalid JSON without leaking response data', async () => {
    wire.mockResolvedValueOnce(new Response('{"messages":', { status: 200 }));
    await expect(provider.postAnalytics(chatId, token, mid, 2)).rejects.toThrow(
      'unexpected response',
    );
  });

  it('rejects ambiguous duplicate matches instead of choosing one', async () => {
    wire.mockResolvedValueOnce(response({ messages: [message(7), message(9)] }));
    expect(await provider.postAnalytics(chatId, token, mid, 2)).toEqual([]);
  });

  it.each([401, 403, 404])(
    'keeps GET %i failures sanitized and never fabricates zero',
    async status => {
      wire.mockResolvedValueOnce(response({ error: token }, status));
      const error = await provider.postAnalytics(chatId, token, mid, 2).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
      expect(wire).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a rate-limited GET and accepts a later valid response', async () => {
    wire.mockResolvedValueOnce(response({ error: token }, 429))
      .mockResolvedValueOnce(response({ messages: [message(17)] }));
    expect(await provider.postAnalytics(chatId, token, mid, 2)).toMatchObject([
      { label: 'Views', data: [{ total: '17' }] },
    ]);
    expect(wire).toHaveBeenCalledTimes(2);
    expect(timer).toHaveBeenCalledWith(5000);
    expect(wire.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it.each([429, 500, 503])(
    'exhausts GET %i retries without leaking tokens or fabricating views',
    async status => {
      wire.mockImplementation(async () => response({ error: token }, status));
      const error = await provider.postAnalytics(chatId, token, mid, 2).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
      expect(wire).toHaveBeenCalledTimes(4);
      expect(timer).toHaveBeenCalledTimes(3);
    },
  );
});


describe('StoryGo Gateway (synthetic HTTPS only)', () => {
  const operationId = 'e299b442-02a8-5acf-ab16-6ab92926d548';
  const revision = 'max_' + 'a'.repeat(64);
  const gatewayKey = 'synthetic-gateway-secret-with-32-characters';
  const settings = () => ({
    mode: 'story',
    continuationText: 'Часть два\n────────────────────────\nЧасть три',
    __gateway: { operationId, externalPostId: post.id, revision },
  });
  const receipt = (state: string, message_id: string | null = null) => ({
    operation_id: operationId, channel_id: chatId, state, message_id, error: null,
  });
  async function withGatewayEnv(fn: () => Promise<void>) {
    const keys = [
      'STORYGO_GATEWAY_ENABLED', 'STORYGO_GATEWAY_BASE_URL',
      'STORYGO_GATEWAY_SERVICE_KEY', 'STORYGO_GATEWAY_ALLOWED_CHANNELS',
    ] as const;
    const saved = keys.map((key) => process.env[key]);
    process.env.STORYGO_GATEWAY_ENABLED = '1';
    process.env.STORYGO_GATEWAY_BASE_URL = 'https://gateway.example.invalid';
    process.env.STORYGO_GATEWAY_SERVICE_KEY = gatewayKey;
    process.env.STORYGO_GATEWAY_ALLOWED_CHANNELS = chatId;
    try { await fn(); } finally {
      keys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key];
        else process.env[key] = saved[i];
      });
    }
  }

  it('sends exactly one POST with deterministic identity and reconciles 202 by GET', async () => {
    await withGatewayEnv(async () => {
      wire.mockResolvedValueOnce(response(receipt('SENDING'), 202))
        .mockResolvedValueOnce(response(receipt('PUBLISHED', 'mid.test-1')));
      const result = await provider.post(chatId, token, [
        { ...post, message: 'Заголовок\nПервая часть', settings: settings() },
      ]);
      expect(result).toEqual([
        { id: post.id, postId: 'mid.test-1', releaseURL: '', status: 'completed' },
      ]);
      expect(wire).toHaveBeenCalledTimes(2);
      expect(wire.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
      expect(wire.mock.calls[0][0]).toBe('https://gateway.example.invalid/gateway/v1/publications');
      expect(wire.mock.calls[1][0]).toContain('/publications/' + operationId);
      expect(wire.mock.calls[0][1].headers.Authorization).toBe('Bearer ' + gatewayKey);
      expect(wire.mock.calls[0][1].headers['Idempotency-Key']).toBe(operationId);
      expect(JSON.parse(wire.mock.calls[0][1].body)).toMatchObject({
        type: 'story', channel_id: chatId, external_post_id: post.id,
        operation_id: operationId, revision,
        parts: ['Заголовок\nПервая часть', 'Часть два', 'Часть три'],
      });
      expect(JSON.stringify(wire.mock.calls)).not.toContain(token);
      expect(wire.mock.calls[0][1].retryPolicy).toBeUndefined();
      expect(wire.mock.calls[0][1].redirect).toBe('error');
    });
  });

  it('never repeats POST after an ambiguous transport error; read-only GET may confirm it', async () => {
    await withGatewayEnv(async () => {
      wire.mockRejectedValueOnce(new Error('network: ' + token))
        .mockResolvedValueOnce(response(receipt('PUBLISHED', 'mid.after-timeout')));
      const result = await provider.post(chatId, token, [
        { ...post, message: 'Заголовок', settings: settings() },
      ]);
      expect(result[0].postId).toBe('mid.after-timeout');
      expect(wire.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
    });
  });

  it('maps 202 then NEEDS_REVIEW to an unknown delivery without a second POST', async () => {
    await withGatewayEnv(async () => {
      wire.mockResolvedValueOnce(response(receipt('SENDING'), 202))
        .mockResolvedValueOnce(response(receipt('NEEDS_REVIEW')));
      await expect(provider.post(chatId, token, [
        { ...post, message: 'Заголовок', settings: settings() },
      ])).rejects.toThrow('operator review');
      expect(wire.mock.calls.map(([, init]) => init.method)).toEqual(['POST', 'GET']);
      expect(wire.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    });
  });

  it('fails closed without channel allowlist or on a foreign/invalid receipt', async () => {
    const payload = [{ ...post, message: 'Заголовок', settings: settings() }];
    await expect(provider.post(chatId, token, payload)).rejects.toThrow('disabled');
    expect(wire).not.toHaveBeenCalled();
    await withGatewayEnv(async () => {
      wire.mockResolvedValueOnce(response({ ...receipt('PUBLISHED', 'mid.bad'), channel_id: '-3' }));
      const err = await provider.post(chatId, token, payload).catch(e => e);
      expect(err.message).toContain('does not match');
      expect(wire).toHaveBeenCalledTimes(1);
      expect(err.message).not.toContain(token);
    });
  });
});
