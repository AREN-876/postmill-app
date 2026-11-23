import { createHash } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { EditorialExchangeService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';
import { EditorialExchangeModule } from '../editorial-exchange.module';
import { EDITORIAL_EXCHANGE_CONFIG } from './editorial-exchange.controller';

vi.mock('@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository', () => ({
  PostsRepository: class PostsRepository {},
}));
const posts = {
  exchangeCreateEditorialDraft: vi.fn(),
  exchangeInstallEditorialText: vi.fn(),
  exchangeReadEditorialDraft: vi.fn(),
};
@Global()
@Module({
  providers: [{ provide: PostsRepository, useValue: posts }],
  exports: [PostsRepository],
})
class FakePostsModule {}

const secret = 'edx_v1_' + 'a'.repeat(64);
const authorization = 'Bearer ' + secret;
const scope = {
  org_id: 'org-a', integration_id: 'max-a', campaign_id: 'campaign-a',
  channel_id: '42', profile_ref: 'life-stories-terra-test@v1',
  is_test: true, image_mode: 'after_text_approval',
};
const config = {
  credential: {
    ...scope, token_sha256: createHash('sha256').update(secret).digest('hex'),
    expires_at: '2099-01-01T00:00:00.000Z',
  },
  targetInternalId: 'test-channel',
};
const content = {
  title: 'Заголовок',
  parts: ['Первый «текст» 😀\nСтрока "цитата" и \\ путь', 'Второй\tтекст', 'Третий\nфинал'],
};
const body = {
  schema_version: 1, task_id: '4', ...scope,
  text: { revision: 1, sha256: '718025e8f4c2b602bfaf1605f6c9183ee8b5edb60382b6cb929d3ca518f1e840' },
  content,
};
const receipt = { state: 'DRAFT', native_verified: true, review_acknowledged: false };
const raw = JSON.stringify(body);
let app: INestApplication;
let url: string;

describe('Editorial Exchange private HTTP (synthetic localhost only)', () => {
  beforeAll(async () => {
    const testingModule = await Test.createTestingModule({
      imports: [FakePostsModule, EditorialExchangeModule],
    }).overrideProvider(EDITORIAL_EXCHANGE_CONFIG).useValue(config).compile();
    app = testingModule.createNestApplication({ rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()) + '/internal/editorial/v1/drafts';
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    vi.resetAllMocks();
    posts.exchangeCreateEditorialDraft.mockResolvedValue({ ...receipt, created: true });
    posts.exchangeInstallEditorialText.mockResolvedValue({ ...receipt, installed: true });
    posts.exchangeReadEditorialDraft.mockResolvedValue(receipt);
  });
  const post = (value: string = raw, auth: string = authorization, path = '') =>
    fetch(url + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: value,
    });
  it('accepts exact compact JSON and reads under the same trusted scope, without cache', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ...receipt, created: true });
    expect(posts.exchangeCreateEditorialDraft).toHaveBeenCalledWith(
      expect.objectContaining({ scope, task_id: '4', text: body.text, content }), 'test-channel',
    );
    const get = await fetch(url + '/4', { headers: { Authorization: authorization } });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(receipt);
    expect(posts.exchangeReadEditorialDraft).toHaveBeenCalledWith(scope, '4', 'test-channel');
  });
  it.each(['pm_live_x', 'pos_x', 'Bearer edx_v1_' + 'b'.repeat(64), ''])(
    'rejects ordinary, invalid and absent credentials without DB access', async (auth) => {
      const response = await post(raw, auth);
      expect(response.status).toBe(401);
      const get = await fetch(url + '/4', { headers: { Authorization: auth, Cookie: 'auth=fake' } });
      expect(get.status).toBe(401);
      expect(posts.exchangeCreateEditorialDraft).not.toHaveBeenCalled();
      expect(posts.exchangeReadEditorialDraft).not.toHaveBeenCalled();
    },
  );
  it.each([
    raw.replace('"task_id":"4"', '"task_id":"5","task_id":"4"'),
    JSON.stringify(body, null, 2),
    JSON.stringify({ ...body, state: 'QUEUE' }),
    JSON.stringify({ ...body, text: { ...body.text, sha256: '0'.repeat(64) } }),
  ])('rejects ambiguous or invalid input before DB access', async (payload) => {
    expect((await post(payload)).status).toBe(400);
    expect(posts.exchangeCreateEditorialDraft).not.toHaveBeenCalled();
  });
  it('denies cross-org claims and query overrides', async () => {
    expect((await post(JSON.stringify({ ...body, org_id: 'org-b' }))).status).toBe(403);
    expect((await post(raw, authorization, '?organization=elsewhere')).status).toBe(400);
    expect((await fetch(url + '/4?org=elsewhere', { headers: { Authorization: authorization } })).status).toBe(400);
    expect(posts.exchangeCreateEditorialDraft).not.toHaveBeenCalled();
    expect(posts.exchangeReadEditorialDraft).not.toHaveBeenCalled();
  });
  it('returns scoped 404 and sanitized conflict/unknown errors, no automatic retry', async () => {
    posts.exchangeReadEditorialDraft.mockResolvedValueOnce(null);
    expect((await fetch(url + '/4', { headers: { Authorization: authorization } })).status).toBe(404);
    posts.exchangeCreateEditorialDraft.mockRejectedValueOnce({
      code: 'P2010', meta: { code: '55000', message: 'private SQL and token' },
    });
    const conflict = await post();
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain('private SQL');
    posts.exchangeCreateEditorialDraft.mockRejectedValueOnce(new Error('private provider secret'));
    const unknown = await post();
    expect(unknown.status).toBe(503);
    expect(await unknown.text()).not.toContain('private provider secret');
    expect(posts.exchangeCreateEditorialDraft).toHaveBeenCalledTimes(2);
  });
  it('installs a final pre-review artifact under the same machine scope and no-cache route', async () => {
    const res = await post(raw, authorization, '/4/install-text');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ...receipt, installed: true });
    expect(posts.exchangeInstallEditorialText).toHaveBeenCalledWith(
      expect.objectContaining({ scope, task_id: '4', text: body.text, content }), 'test-channel',
    );
    expect(posts.exchangeCreateEditorialDraft).not.toHaveBeenCalled();
    expect((await post(raw, 'Bearer edx_v1_' + 'b'.repeat(64), '/4/install-text')).status).toBe(401);
    expect((await post(raw, authorization, '/5/install-text')).status).toBe(400);
    expect((await post(JSON.stringify({ ...body, content: { ...content, title: 'Подмена' } }),
      authorization, '/4/install-text')).status).toBe(400);
    expect(posts.exchangeInstallEditorialText).toHaveBeenCalledTimes(1);
  });
  it('rejects a conflicting install without exposing SQL details', async () => {
    posts.exchangeInstallEditorialText.mockRejectedValueOnce({
      code: 'P2010', meta: { code: '55000', message: 'secret: never return' },
    });
    const response = await post(raw, authorization, '/4/install-text');
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain('secret:');
  });
  it('the isolated module has no configured credential by default', async () => {
    const disabledModule = await Test.createTestingModule({
      imports: [FakePostsModule, EditorialExchangeModule],
    }).compile();
    try {
      expect(disabledModule.get(EDITORIAL_EXCHANGE_CONFIG)).toBeNull();
    } finally {
      await disabledModule.close();
    }
    expect(posts.exchangeCreateEditorialDraft).not.toHaveBeenCalled();
    expect(posts.exchangeReadEditorialDraft).not.toHaveBeenCalled();
  });
  it('fails closed with null configuration or duplicate Authorization', async () => {
    const svc = app.get(EditorialExchangeService);
    const request = {
      authorization, rawHeaders: ['authorization', authorization, 'content-type', 'application/json'],
      contentType: 'application/json', contentEncoding: undefined, queryPresent: false,
      rawBody: Buffer.from(raw), body,
    };
    await expect(svc.create(request, null)).rejects.toThrow('unauthorized');
    await expect(svc.read('4', request, null)).rejects.toThrow('unauthorized');
    await expect(svc.create({ ...request, rawHeaders: [...request.rawHeaders, 'Authorization', authorization] }, config))
      .rejects.toThrow('unauthorized');
    expect(posts.exchangeCreateEditorialDraft).not.toHaveBeenCalled();
    expect(posts.exchangeReadEditorialDraft).not.toHaveBeenCalled();
  });
});
