import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MaxProvider, maxSocialModule, type EditorialStoryGoDispatchContext } from '../social.adapter';
import { maxStoryParts } from '@postmill-ai/provider-kernel/domains/max-story';
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
  it('advertises one media attachment and remains unverified without a live sandbox', () => {
    expect(maxSocialModule.manifest.capabilities).toMatchObject({
      maxMedia: 1,
      video: true,
      altText: false,
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
    { poll: { options: ['a', 'b'], duration: 1 } },
    { firstComment: 'comment' },
    { settings: { firstComment: 'comment' } },
  ])('rejects unsupported payload %# before any HTTP', async (extra) => {
    await expect(
      provider.post(chatId, token, [{ ...post, ...extra } as any]),
    ).rejects.toThrow('first comments');
    expect(wire).not.toHaveBeenCalled();
  });
  it('rejects threads and multiple media items in server validation', async () => {
    expect(await provider.checkValidity([[], []])).toMatch('threads');
    expect(await provider.checkValidity([[{ path: 'image.png' }]])).toBe(true);
    expect(await provider.checkValidity([[{ path: 'a.png' }, { path: 'b.png' }]])).toMatch('one image');
    expect(await provider.checkValidity([[]])).toBe(true);
    await expect(provider.post(chatId, token, [post, post])).rejects.toThrow(
      'exactly one',
    );
    expect(wire).not.toHaveBeenCalled();
  });

  it.each([
    ['image', 'image/png', 'https://iu.oneme.ru/uploadImage?apiToken=abc', {}, { photos: { photoIds: { token: 'image-upload-token' } } }, 'image-upload-token'],
    ['video', 'video/mp4', 'https://omub.okcdn.ru/upload.do?upload=xyz', { token: 'video-reserved-token' }, { retval: 1 }, 'video-reserved-token'],
  ] as const)('sends one %s attachment after upload and only one message POST', async (
    mediaType, mimeType, uploadUrl, extraSetup, uploadResult, expectedToken,
  ) => {
    const bytes = Buffer.from('synthetic media bytes validated by PostsService');
    const media = { mediaType, mimeType, base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') };
    checks();
    wire.mockResolvedValueOnce(response({ url: uploadUrl, ...extraSetup }))
      .mockResolvedValueOnce(response(uploadResult))
      .mockResolvedValueOnce(response(sent));
    const result = await provider.post(chatId, token, [{
      ...post, message: 'Media caption',
      media: [{ type: mediaType, path: '/ignored', id: 'file-id' }],
      settings: { __type: 'max', mode: 'normal', __maxMedia: media },
    } as any]);
    expect(result[0].postId).toBe('synthetic-mid');
    const calls = wire.mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls[3][0]).toBe('https://platform-api2.max.ru/uploads?type=' + mediaType);
    expect(calls[3][1].method).toBe('POST');
    expect(calls[3][1].headers.Authorization).toBe(token);
    expect(calls[4][0]).toBe(uploadUrl);
    expect(calls[4][1].method).toBe('POST');
    expect(calls[4][1].headers?.Authorization).toBe(
      mediaType === 'image' ? token : undefined,
    );
    expect(calls[4][1].headers['content-type']).toContain('multipart/form-data; boundary=');
    expect(calls[4][1].body).toBeInstanceOf(Buffer);
    expect(calls[4][1].body.toString()).toContain('name="data"');
    expect(JSON.parse(calls[5][1].body)).toEqual({
      text: 'Media caption', attachments: [{ type: mediaType, payload: { token: expectedToken } }],
    });
    expect(calls.filter(([, init]) => init.method === 'POST')).toHaveLength(3);
    expect(timer).toHaveBeenCalledWith(mediaType === 'video' ? 10000 : 2000);
  });


  it('accepts MAX XML video upload success before sending the sole message', async () => {
    const bytes = Buffer.from('synthetic video upload bytes');
    const media = { mediaType: 'video', mimeType: 'video/mp4',
      base64: bytes.toString('base64'),
      sha256: createHash('sha256').update(bytes).digest('hex') };
    checks();
    wire.mockResolvedValueOnce(response({
      url: 'https://omub.okcdn.ru/upload.do?sig=test', token: 'video-token',
    })).mockResolvedValueOnce(new Response('<retval>1</retval>', {
      status: 200, headers: { 'Content-Type': 'text/xml' },
    })).mockResolvedValueOnce(response(sent));
    await expect(provider.post(chatId, token, [{
      ...post, media: [{ type: 'video', path: '/ignored' }],
      settings: { __type: 'max', __maxMedia: media },
    }])).resolves.toHaveLength(1);
    expect(JSON.parse(wire.mock.calls[5][1].body).attachments).toEqual([
      { type: 'video', payload: { token: 'video-token' } },
    ]);
  });

  it('blocks a message on MAX XML video upload failure', async () => {
    const bytes = Buffer.from('synthetic video upload bytes');
    checks();
    wire.mockResolvedValueOnce(response({
      url: 'https://omub.okcdn.ru/upload.do?sig=test', token: 'video-token',
    })).mockResolvedValueOnce(new Response('<retval>0</retval>', { status: 200 }));
    const err = await provider.post(chatId, token, [{
      ...post, media: [{ type: 'video', path: '/ignored' }],
      settings: { __type: 'max', __maxMedia: {
        mediaType: 'video', mimeType: 'video/mp4',
        base64: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } },
    }]).catch(e => e);
    expect(err.message).toContain('operator review');
    expect(wire).toHaveBeenCalledTimes(5);
  });

  it('rejects non-MAX upload hosts without leaking the bot token or sending a message', async () => {
    const bytes = Buffer.from('media');
    checks();
    wire.mockResolvedValueOnce(response({ url: 'https://example.invalid/upload' }));
    const err = await provider.post(chatId, token, [{
      ...post, media: [{ type: 'image', path: 'ignored' }],
      settings: { __type: 'max', __maxMedia: {
        mediaType: 'image', mimeType: 'image/png', base64: bytes.toString('base64'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } },
    }]).catch((e) => e);
    expect(err.message).toContain('operator review');
    expect(JSON.stringify(err)).not.toContain(token);
    expect(wire).toHaveBeenCalledTimes(4);
    expect(wire.mock.calls.every(([url]) => !String(url).startsWith('https://example.invalid'))).toBe(true);
  });

  it('rejects missing or mismatched media snapshot without any write', async () => {
    const media = [{ type: 'image' as const, path: 'ignored' }];
    await expect(provider.post(chatId, token, [{ ...post, media }])).rejects.toThrow('verified media');
    expect(wire).not.toHaveBeenCalled();
    const bytes = Buffer.from('changed');
    checks();
    await expect(provider.post(chatId, token, [{
      ...post, media,
      settings: { __type: 'max', __maxMedia: {
        mediaType: 'image', mimeType: 'image/png', base64: bytes.toString('base64'),
        sha256: 'f'.repeat(64),
      } },
    }])).rejects.toThrow('approved snapshot');
    expect(wire.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
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

  it('uploads an approved PNG by multipart without URLs, then publishes with its upload_id', async () => {
    await withGatewayEnv(async () => {
      const bytes = Buffer.from('synthetic PNG bytes (validated by PostsService)');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const uploadId = 'a8db6639-7ba0-42b7-8587-dd39d630c91b';
      wire.mockResolvedValueOnce(response({
        upload_id: uploadId, sha256, mime_type: 'image/png', bytes: bytes.length,
      }, 201)).mockResolvedValueOnce(response(receipt('PUBLISHED', 'mid.photo')));
      const result = await provider.post(chatId, token, [{
        ...post,
        message: 'Заголовок',
        settings: {
          ...settings(),
          __gateway: {
            ...settings().__gateway,
            image: { base64: bytes.toString('base64'), mimeType: 'image/png', sha256 },
          },
        },
      }]);
      expect(result[0].postId).toBe('mid.photo');
      expect(wire.mock.calls.map(([url]) => url)).toEqual([
        'https://gateway.example.invalid/gateway/v1/media',
        'https://gateway.example.invalid/gateway/v1/publications',
      ]);
      const mediaRequest = wire.mock.calls[0][1];
      expect(mediaRequest.method).toBe('POST');
      expect(mediaRequest.headers.Authorization).toBe('Bearer ' + gatewayKey);
      expect(mediaRequest.headers['content-type']).toContain('multipart/form-data; boundary=');
      expect(mediaRequest.body).toBeInstanceOf(Buffer);
      expect(mediaRequest.body.toString()).toContain('name="channel_id"');
      expect(mediaRequest.body.toString()).toContain('name="file"; filename="story.png"');
      expect(JSON.parse(wire.mock.calls[1][1].body).upload_id).toBe(uploadId);
      expect(JSON.stringify(wire.mock.calls.map(([url, init]) => [url, init.headers])))
        .not.toContain(token);
    });
  });

  it.each(['success','upload_timeout','upload_wrong_digest','publish_timeout'] as const)(
    'keeps JPEG upload and publication one-shot: %s', async (scenario) => {
      await withGatewayEnv(async () => {
        // Transport-only fixture; full decode is tested in the private reader.
        const bytes=Buffer.from('ffd8ffd9','hex');
        const sha256=createHash('sha256').update(bytes).digest('hex');
        const uploadId='a8db6639-7ba0-42b7-8587-dd39d630c91b';
        if(scenario==='upload_timeout') wire.mockRejectedValueOnce(new Error('ambiguous upload'));
        else {
          wire.mockResolvedValueOnce(response({upload_id:uploadId,
            sha256:scenario==='upload_wrong_digest'?'0'.repeat(64):sha256,
            mime_type:'image/jpeg',bytes:bytes.length},201));
          if(scenario==='publish_timeout') wire.mockRejectedValueOnce(new Error('ambiguous publish'))
            .mockResolvedValueOnce(response(receipt('NEEDS_REVIEW')));
          else wire.mockResolvedValueOnce(response(receipt('PUBLISHED','mid.jpeg')));
        }
        const call=provider.post(chatId,token,[{...post,message:'Заголовок',
          settings:{...settings(),__gateway:{...settings().__gateway,
            image:{base64:bytes.toString('base64'),mimeType:'image/jpeg',sha256}}}}]);
        if(scenario==='success') expect((await call)[0].postId).toBe('mid.jpeg');
        else await expect(call).rejects.toThrow('operator review');
        const urls=wire.mock.calls.map(([url,init])=>[url,init.method]);
        const media='https://gateway.example.invalid/gateway/v1/media';
        const publication='https://gateway.example.invalid/gateway/v1/publications';
        expect(urls).toEqual(scenario==='success'?[[media,'POST'],[publication,'POST']]:
          scenario==='publish_timeout'?[[media,'POST'],[publication,'POST'],[publication+'/'+operationId,'GET']]:
          [[media,'POST']]);
        expect(wire.mock.calls[0][1].body.toString()).toContain('filename="story.jpg"');
        expect(wire.mock.calls[0][1].body.includes(bytes)).toBe(true);
        if(scenario==='success'||scenario==='publish_timeout'){
          const payload=JSON.parse(wire.mock.calls[1][1].body);
          expect(payload.upload_id).toBe(uploadId);
          expect(payload.operation_id).toBe(operationId);
          expect(JSON.stringify(payload)).not.toContain(bytes.toString('base64'));
        }
      });
    });


  describe('028B.4B private editorial transport boundary (fake wire)', () => {
    const channel = '-73052031470103';
    const publication = 'b'.repeat(32);
    const bytes = Buffer.from('ffd8ffd9', 'hex'); // transport fixture; decode is a private reader gate
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const photo = { base64: bytes.toString('base64'), mimeType: 'image/jpeg' as const, sha256 };
    const now = 1800000000000;
    const outbound = { ...post, id: publication, message: 'Заголовок\nПервая часть',
      settings: { mode: 'story', continuationText: settings().continuationText } };
    const identity = { orgId: 'org-modes', publicationPostId: publication, occurrenceId: revision,
      attempt: 1 as const, operationId, channelId: channel, fingerprint: 'c'.repeat(64),
      storyPartsSha256: createHash('sha256').update(JSON.stringify(
        maxStoryParts(outbound.message, outbound.settings.continuationText))).digest('hex'),
      photoSha256: sha256 };
    const upload = (remaining = 300) => ({ upload_id: 'a8db6639-7ba0-42b7-8587-dd39d630c91b',
      sha256, mime_type: 'image/jpeg', bytes: bytes.length, expires_at: now / 1000 + remaining });
    const final = { operation_id: operationId, channel_id: channel, state: 'PUBLISHED', message_id: 'mid.fake' };
    const calls = () => wire.mock.calls.map(([url, init]) => [String(url).split('/gateway/v1/')[1], init.method]);
    async function isolated(fn: () => Promise<void>) {
      await withGatewayEnv(async () => {
        const flag = 'EDITORIAL_TEST_LIVE_IMAGE_RELEASE_WORKER_ENABLED';
        const saved = process.env[flag];
        process.env[flag] = '1';
        process.env.STORYGO_GATEWAY_ALLOWED_CHANNELS = channel;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try { await fn(); } finally {
          clock.mockRestore();
          if (saved === undefined) delete process.env[flag]; else process.env[flag] = saved;
        }
      });
    }
    function context(beforePublication = vi.fn(async () => ({ allowed: true as const }))): EditorialStoryGoDispatchContext {
      return { kind: 'editorial-live-story', identity, beforePublication };
    }

    it('allows exactly 300s, validates the receipt before one callback and one POST', async () => {
      await isolated(async () => {
        const gate = vi.fn(async () => {
          expect(calls()).toEqual([['media', 'POST']]);
          return { allowed: true as const };
        });
        wire.mockResolvedValueOnce(response(upload(), 201)).mockResolvedValueOnce(response(final));
        expect((await provider.postEditorialLiveStory(channel, outbound, photo, context(gate)))[0].postId)
          .toBe('mid.fake');
        expect(gate).toHaveBeenCalledExactlyOnceWith(upload());
        expect(calls()).toEqual([['media', 'POST'], ['publications', 'POST']]);
        const payload = JSON.parse(wire.mock.calls[1][1].body);
        expect(payload).toMatchObject({ external_post_id: publication, operation_id: operationId,
          revision, channel_id: channel, upload_id: upload().upload_id });
        expect(JSON.stringify(payload)).not.toContain(photo.base64);
      });
    });

    it.each(['ttl299','missing','ms','uuid','digest','mime','size','future'] as const)(
      'holds invalid upload receipt %s before callback', async scenario => {
        await isolated(async () => {
          const value: Record<string, unknown> = upload();
          if (scenario === 'ttl299') value.expires_at = now / 1000 + 299;
          if (scenario === 'missing') delete value.expires_at;
          if (scenario === 'ms') value.expires_at = now + 300000;
          if (scenario === 'uuid') value.upload_id = operationId;
          if (scenario === 'digest') value.sha256 = 'f'.repeat(64);
          if (scenario === 'mime') value.mime_type = 'image/png';
          if (scenario === 'size') value.bytes = bytes.length + 1;
          if (scenario === 'future') value.expires_at = now / 1000 + 3631;
          const gate = vi.fn(async () => ({ allowed: true as const }));
          wire.mockResolvedValueOnce(response(value, 201));
          await expect(provider.postEditorialLiveStory(channel, outbound, photo, context(gate)))
            .rejects.toThrow('operator review');
          expect(gate).not.toHaveBeenCalled();
          expect(calls()).toEqual([['media', 'POST']]);
        });
      });

    it.each(['denied','throw','ttl_after','disabled_after','malformed'] as const)(
      'holds after upload on authority %s', async scenario => {
        await isolated(async () => {
          const gate: EditorialStoryGoDispatchContext['beforePublication'] = vi.fn(async () => {
            if (scenario === 'throw') throw Error('fake authority timeout');
            if (scenario === 'ttl_after') vi.mocked(Date.now).mockReturnValue(now + 1000);
            if (scenario === 'disabled_after') delete process.env.EDITORIAL_TEST_LIVE_IMAGE_RELEASE_WORKER_ENABLED;
            if (scenario === 'denied') return { allowed: false as const };
            if (scenario === 'malformed') return { allowed: true as const, extra: true };
            return { allowed: true as const };
          });
          wire.mockResolvedValueOnce(response(upload(), 201));
          await expect(provider.postEditorialLiveStory(channel, outbound, photo,
            { kind: 'editorial-live-story', identity, beforePublication: gate })).rejects.toThrow('operator review');
          expect(gate).toHaveBeenCalledTimes(1);
          expect(calls()).toEqual([['media', 'POST']]);
        });
      });

    it('refuses disabled or wrong immutable identity before upload', async () => {
      await isolated(async () => {
        await expect(provider.postEditorialLiveStory(channel, outbound, photo,
          { ...context(), identity: { ...identity, operationId: 'wrong' } })).rejects.toThrow('operator review');
        delete process.env.EDITORIAL_TEST_LIVE_IMAGE_RELEASE_WORKER_ENABLED;
        await expect(provider.postEditorialLiveStory(channel, outbound, photo, context()))
          .rejects.toThrow('operator review');
        expect(wire).not.toHaveBeenCalled();
      });
    });

    it('does not reupload or POST after lost upload response', async () => {
      await isolated(async () => {
        wire.mockRejectedValueOnce(Error('fake upload lost'));
        await expect(provider.postEditorialLiveStory(channel, outbound, photo, context()))
          .rejects.toThrow('operator review');
        expect(calls()).toEqual([['media', 'POST']]);
      });
    });

    it.each(['lost','malformed'] as const)('uses only GET after %s publication response', async scenario => {
      await isolated(async () => {
        wire.mockResolvedValueOnce(response(upload(), 201));
        if (scenario === 'lost') wire.mockRejectedValueOnce(Error('fake publication lost'));
        else wire.mockResolvedValueOnce(response({ ...final, channel_id: '-9' }));
        wire.mockResolvedValueOnce(response(final));
        expect((await provider.postEditorialLiveStory(channel, outbound, photo, context()))[0].postId)
          .toBe('mid.fake');
        expect(calls()).toEqual([['media', 'POST'], ['publications', 'POST'],
          ['publications/' + operationId, 'GET']]);
      });
    });
  });

  it('rejects photo content changes before any HTTP request', async () => {
    await withGatewayEnv(async () => {
      const err = await provider.post(chatId, token, [{
        ...post, message: 'Заголовок',
        settings: {
          ...settings(),
          __gateway: {
            ...settings().__gateway,
            image: {
              base64: Buffer.from('not this digest').toString('base64'),
              mimeType: 'image/png',
              sha256: 'f'.repeat(64),
            },
          },
        },
      }]).catch((e) => e);
      expect(err.message).toContain('approved snapshot');
      expect(wire).not.toHaveBeenCalled();
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
