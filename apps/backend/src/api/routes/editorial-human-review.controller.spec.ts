import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthMiddleware } from '@postmill-ai/backend/services/auth/auth.middleware';
import { CsrfMiddleware } from '@postmill-ai/backend/services/auth/csrf.middleware';
import { OrgRbacGuard } from '@postmill-ai/backend/services/auth/rbac/org-rbac.guard';
import { AuthContextResolver } from '@postmill-ai/nestjs-libraries/auth/auth-context.resolver';
import { RolesService } from '@postmill-ai/nestjs-libraries/database/prisma/roles/roles.service';
import { AuditService } from '@postmill-ai/nestjs-libraries/database/prisma/audit/audit.service';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import {
  EditorialHumanReviewService, EDITORIAL_HUMAN_REVIEW_CONFIG,
} from '@postmill-ai/backend/services/editorial/editorial-human-review.service';
import { EditorialHumanReviewController } from './editorial-human-review.controller';
import fs from 'node:fs';
import nodePath from 'node:path';

const posts = {
  readEditorialHuman: vi.fn(),
  queueEditorialHuman: vi.fn(),
};
const roles = { getEffectivePermissions: vi.fn() };
const audit = { record: vi.fn() };
const resolver = { resolve: vi.fn() };
const config = { enabled: true, testOrgId: 'org-a', targetInternalId: 'test-channel' };
const postId = 'a'.repeat(32);
const path = '/editorial/review/' + postId + '/198';
const command = {
  command_id: '11111111-1111-4111-8111-111111111111',
  expected_seq: '0', action: 'approve_text', feedback: '',
};

// Vitest transpilation does not emit constructor design:paramtypes for the
// production middleware; keep its actual use() logic, inject the fake resolver
// explicitly in this isolated HTTP harness.
class TestSessionAuthMiddleware extends AuthMiddleware {
  constructor() { super(resolver as never); }
}
@Global()
@Module({
  controllers: [EditorialHumanReviewController],
  providers: [
    EditorialHumanReviewService,
    { provide: OrgRbacGuard, useValue: new OrgRbacGuard(new Reflector(), roles as never, audit as never) },
    { provide: PostsRepository, useValue: posts },
    { provide: RolesService, useValue: roles },
    { provide: AuditService, useValue: audit },
    { provide: AuthContextResolver, useValue: resolver },
    { provide: EDITORIAL_HUMAN_REVIEW_CONFIG, useValue: config },
  ],
})
class IsolatedHumanReviewModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Same two middleware as ApiModule.authenticatedController.
    consumer.apply(TestSessionAuthMiddleware).forRoutes(EditorialHumanReviewController);
    consumer.apply(CsrfMiddleware).forRoutes(EditorialHumanReviewController);
  }
}

let app: INestApplication;
let url: string;
const csrf = 'csrf-token-123';
const cookie = 'auth=valid; csrf_token=' + csrf;
const read = (extra: Record<string, string> = {}, session = cookie) =>
  fetch(url + path, { headers: { cookie: session, ...extra } });
const decision = (value: unknown = command, extra: Record<string, string> = {}, session = cookie) =>
  fetch(url + path + '/decisions', {
    method: 'POST',
    headers: { cookie: session, 'content-type': 'application/json', 'x-csrf-token': csrf, ...extra },
    body: JSON.stringify(value),
  });

describe('06B-4A isolated cookie-only human review HTTP', () => {
  beforeAll(async () => {
    process.env.FRONTEND_URL ||= 'https://example.net';
    const mod = await Test.createTestingModule({ imports: [IsolatedHumanReviewModule] })
      .overrideGuard(OrgRbacGuard)
      .useValue(new OrgRbacGuard(new Reflector(), roles as never, audit as never))
      .compile();
    app = mod.createNestApplication({ logger: ['error'] });
    app.use(cookieParser());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => {
    vi.resetAllMocks();
    resolver.resolve.mockImplementation(async ({ jwt }: { jwt: string }) => {
      const orgId = jwt === 'other-org' ? 'org-b' : 'org-a';
      return { ok: true, context: { org: { id: orgId }, user: { id: jwt === 'viewer' ? 'viewer' : jwt === 'owner' ? 'owner' : 'editor' },
        impersonated: false, expiresAt: null } };
    });
    roles.getEffectivePermissions.mockImplementation(async (_org: string, user: string) =>
      user === 'viewer'
        ? { role: 'viewer', permissions: ['posts:read'] }
        : user === 'owner'
          ? { role: 'owner', permissions: ['posts:manage'] }
          : { role: 'editor', permissions: ['posts:read', 'posts:update'] });
    posts.readEditorialHuman.mockResolvedValue({
      post_id: postId, task_id: '198', content: { title: 'title', parts: ['a','b','c'] },
      review: { status: 'idle', last_confirmed_state: { seq: '0' } },
      remote_current_verified: false, dispatch_authorized: false, publishable: false,
    });
    posts.queueEditorialHuman.mockResolvedValue({
      status: 'queued/unconfirmed', newly_queued: true, replay: false,
      event_id: '22222222-2222-4222-8222-222222222222',
      dispatch_authorized: false, publishable: false,
    });
    audit.record.mockResolvedValue(undefined);
  });

  it('has the existing cookie/CSRF middleware and fail-closed test-only runtime import', () => {
    const source = fs.readFileSync(nodePath.resolve(__dirname, '../editorial-human-review.module.ts'), 'utf8');
    const runtime = fs.readFileSync(nodePath.resolve(__dirname, '../api.module.ts'), 'utf8');
    const app = fs.readFileSync(nodePath.resolve(__dirname, '../../app.module.ts'), 'utf8');
    expect(source).toContain('export const authenticatedController = [EditorialHumanReviewController, EditorialReleaseController]');
    expect(source).toContain('editorialReleaseConfig(process.env)');
    expect(source).toContain('editorialSessionConfig(process.env)');
    expect(runtime).not.toContain('EditorialReleaseModule');
    expect(runtime).not.toContain('EditorialReleaseController');
    expect(app).not.toContain('EditorialReleaseController');
    expect(source).toContain('consumer.apply(AuthMiddleware).forRoutes(...authenticatedController)');
    expect(source).toContain('consumer.apply(CsrfMiddleware).forRoutes(...authenticatedController)');
    expect(runtime).not.toContain('EditorialHumanReviewController');
    expect(runtime).not.toContain('EditorialHumanReviewModule');
    expect(app).toContain('editorialSessionRoutesEnabled(process.env)');
    expect(app).toContain('? [EditorialHumanReviewModule]');
    // Machine ingress is allowed only behind its independent, default-off gate.
    expect(app).toContain('editorialMachineRoutesEnabled(process.env)');
    expect(app).toContain('? [EditorialExchangeModule]');
    expect(app).toContain('...editorialMachineModules');
    expect(runtime).not.toContain('EditorialExchangeController');
  });
  it('permits current org editor to read verified text status and queue once', async () => {
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await r.json()).publishable).toBe(false);
    expect(posts.readEditorialHuman).toHaveBeenCalledWith('org-a', postId, '198', 'test-channel');
    const d = await decision();
    expect(d.status).toBe(200);
    expect((await d.json()).status).toBe('queued/unconfirmed');
    expect(posts.queueEditorialHuman).toHaveBeenCalledWith(
      'org-a', postId, '198', 'test-channel', 'editor', command);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'editorial.review.queued', resourceId: postId, userId: 'editor',
    }));
  });
  it('allows owner with posts:manage through session RBAC', async () => {
    const session = 'auth=owner; csrf_token=' + csrf;
    const r = await read({}, session);
    expect(r.status).toBe(200);
    const d = await decision(command, {}, session);
    expect(d.status).toBe(200);
    expect(posts.queueEditorialHuman).toHaveBeenCalledWith(
      'org-a', postId, '198', 'test-channel', 'owner', command);
  });
  it('refuses a request without a cookie session before any database call', async () => {
    const r = await read({}, '');
    expect(r.status).toBe(403);
    const d = await decision(command, {}, '');
    expect(d.status).toBe(403);
    expect(posts.readEditorialHuman).not.toHaveBeenCalled();
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('mock image import remains off and retains session/RBAC checks', async () => {
    const request = (session: string, headers: Record<string,string> = {}) => fetch(url+path+'/image/import',{
      method:'POST',headers:{cookie:session,'content-type':'application/json','x-csrf-token':csrf,...headers},
      body:JSON.stringify({expected_seq:'0'}),
    });
    expect((await request(cookie)).status).toBe(404);
    expect((await request('auth=viewer; csrf_token='+csrf)).status).toBe(403);
    expect((await request('')).status).toBe(403);
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('denies viewer mutation through real OrgRbacGuard', async () => {
    const d = await decision(command, {}, 'auth=viewer; csrf_token=' + csrf);
    expect(d.status).toBe(403);
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('denies missing CSRF even for authorized editor, without DB queue', async () => {
    const d = await decision(command, { 'x-csrf-token': '' });
    expect(d.status).toBe(403);
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('denies header auth bypass, OAuth-looking Authorization and impersonation', async () => {
    for (const headers of [{ auth: 'valid' }, { authorization: 'Bearer public-key' }]) {
      const d = await decision(command, headers);
      expect(d.status).toBe(403);
    }
    const impersonated = await decision(command, {}, cookie + '; impersonate=someone');
    expect(impersonated.status).toBe(403);
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('denies other org despite valid user permissions', async () => {
    const r = await read({}, 'auth=other-org; csrf_token=' + csrf);
    expect(r.status).toBe(404);
    const d = await decision(command, {}, 'auth=other-org; csrf_token=' + csrf);
    expect(d.status).toBe(404);
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('rejects claimed actor/scope and incorrect feedback before any DB write', async () => {
    const extra = await decision({ ...command, actor_id: 'hacker' });
    expect(extra.status).toBe(400);
    const invalid = await decision({ ...command, action: 'request_text_changes', feedback: ' ' });
    expect(invalid.status).toBe(400);
    const stale = await decision({ ...command, expected_seq: '000' });
    expect(stale.status).toBe(400);
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
  it('maps stale state to sanitized conflict; never retries or publishes', async () => {
    posts.queueEditorialHuman.mockRejectedValueOnce({ code: 'P2010', meta: { code: '55000', message: 'secret' } });
    const d = await decision();
    expect(d.status).toBe(409);
    expect(await d.text()).not.toContain('secret');
    expect(posts.queueEditorialHuman).toHaveBeenCalledTimes(1);
  });
  it('default null config fails closed before RBAC/database work', async () => {
    const service = new EditorialHumanReviewService(
      posts as never, roles as never, audit as never, null);
    await expect(service.read('org-a', 'editor', postId, '198')).rejects.toThrow('editorial_review_disabled');
    await expect(service.queue('org-a', 'editor', postId, '198', command)).rejects.toThrow('editorial_review_disabled');
    expect(posts.readEditorialHuman).not.toHaveBeenCalled();
    expect(posts.queueEditorialHuman).not.toHaveBeenCalled();
  });
});
