/**
 * 07: Production controller/service/repository SQL through the FULL Prisma schema.
 * Synthetic CI only. Real production AppModule must remain unregistered.
 *
 * This test is intentionally excluded from ordinary local/test runs even when a
 * developer has DATABASE_URL set. CI must supply all three positive gates.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Reflector } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { EditorialExchangeService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';
import { EditorialHumanReviewController } from './editorial-human-review.controller';
import {
  EditorialHumanReviewService, EDITORIAL_HUMAN_REVIEW_CONFIG,
} from '@postmill-ai/backend/services/editorial/editorial-human-review.service';
import { RolesService } from '@postmill-ai/nestjs-libraries/database/prisma/roles/roles.service';
import { AuditService } from '@postmill-ai/nestjs-libraries/database/prisma/audit/audit.service';
import { OrgRbacGuard } from '@postmill-ai/backend/services/auth/rbac/org-rbac.guard';
import { AuthMiddleware } from '@postmill-ai/backend/services/auth/auth.middleware';
import { CsrfMiddleware } from '@postmill-ai/backend/services/auth/csrf.middleware';
import {
  EditorialExchangeController, EDITORIAL_EXCHANGE_CONFIG,
} from './editorial-exchange.controller';

const databaseUrl = process.env.DATABASE_URL ?? '';
// This is the actual CI ephemeral PostgreSQL service. Never use a VPS,
// external database or arbitrary developer DATABASE_URL for this test.
const ciOnly = process.env.GITHUB_ACTIONS === 'true' &&
  process.env.EDX_REAL_DB_CI === '1' &&
  /^postgresql:\/\/[^\s]+@(?:127\.0\.0\.1|localhost):5432\/postmill-db-local(?:\?|$)/.test(databaseUrl);

describe.skipIf(!ciOnly)('Editorial 07: isolated real Nest HTTP + full Prisma PostgreSQL', () => {
  const suffix = randomUUID().replace(/-/g, '');
  const org = 'ci-org-' + suffix;
  const integration = 'ci-max-' + suffix;
  const target = 'ci-target-' + suffix;
  const campaign = 'ci-campaign-' + suffix;
  const task = '804';
  const profile = 'life-stories-terra-test@v1';
  const secret = 'edx_v1_' + 'a'.repeat(64);
  const authorization = 'Bearer ' + secret;
  const scope = {
    org_id: org, integration_id: integration, campaign_id: campaign,
    channel_id: '42', profile_ref: profile, is_test: true,
    image_mode: 'disabled',
  } as const;
  const content = {
    title: 'Тестовый черновик',
    parts: ['а'.repeat(2900), 'б'.repeat(2900), 'в'.repeat(2900)],
  };
  let prisma: PrismaClient;
  let app: INestApplication;
  let url: string;
  let body: Record<string, unknown>;
  let raw: string;
  let digest: string;

  const post = (payload = raw, auth = authorization) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: auth },
      body: payload,
    });
  const read = (auth = authorization) =>
    fetch(url + '/' + task, { headers: { authorization: auth } });

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();

    // Real foreign keys/constraints, not the simplified SQL fixtures.
    await prisma.$executeRaw`
      INSERT INTO "Organization"(id,name,"updatedAt") VALUES (${org},'Synthetic Editorial CI',now())`;
    await prisma.$executeRaw`
      INSERT INTO "Integration"(
        id,"organizationId","internalId",name,"providerIdentifier",type,token
      ) VALUES (
        ${integration},${org},${target},
        'Synthetic MAX; never send','max','max','synthetic-not-usable'
      )`;
    await prisma.$executeRaw`
      INSERT INTO "Campaign"(id,"organizationId",name,"updatedAt")
      VALUES (${campaign},${org},'Synthetic CI only',now())`;

    // Hash is derived from PostgreSQL jsonb itself: no JS reimplementation
    // of its serialization/canonicalization is trusted by the test.
    const [record] = await prisma.$queryRaw<Array<{ digest: string }>>`
      SELECT encode(
        sha256(convert_to((${JSON.stringify(content)}::jsonb)::text,'UTF8')),
        'hex'
      ) AS digest`;
    digest = record.digest;
    body = {
      schema_version: 1, task_id: task, ...scope,
      text: { revision: 1, sha256: digest }, content,
    };
    raw = JSON.stringify(body);

    // No production AppModule or external routes. Only the actual controller,
    // real service implementation and real PostsRepository methods.
    const repository = Object.assign(Object.create(PostsRepository.prototype), {
      _post: prisma,
    }) as PostsRepository;
    const testingModule = await Test.createTestingModule({
      controllers: [EditorialExchangeController],
      providers: [
        EditorialExchangeService,
        { provide: PostsRepository, useValue: repository },
        { provide: EDITORIAL_EXCHANGE_CONFIG, useValue: {
          targetInternalId: target,
          credential: {
            ...scope,
            token_sha256: createHash('sha256').update(secret).digest('hex'),
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        } },
      ],
    }).compile();
    app = testingModule.createNestApplication({ rawBody: true, logger: false });
    await app.listen(0, '127.0.0.1');
    url = (await app.getUrl()) + '/internal/editorial/v1/drafts';
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    // The entire CI PostgreSQL service is discarded after this job.
    // Managed DRAFT + receipt are intentionally immutable; don't bypass
    // their triggers for teardown and don't touch any production database.
  });

  it('creates exactly one genuine DRAFT and reads the authoritative receipt', async () => {
    const first = await post();
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    const result = await first.json();
    expect(result.created).toBe(true);
    expect(result.receipt.text.sha256).toBe(digest);
    expect(result.receipt.binding).toMatchObject({
      org_id: org, integration_id: integration, task_id: task,
      profile_ref: profile, is_test: true,
    });
    const postId: string = result.receipt.binding.post_id;
    expect(postId).toMatch(/^[0-9a-f]{32}$/);

    const second = await post();
    expect(second.status).toBe(200);
    const replay = await second.json();
    expect(replay.created).toBe(false);
    expect(replay.receipt).toEqual(result.receipt);

    const get = await read();
    expect(get.status).toBe(200);
    const current = await get.json();
    expect(current.native_verified).toBe(true);
    expect(current.receipt).toEqual(result.receipt);
    expect(current.receipt.publishable).toBe(false);
    expect(current.receipt.dispatch_authorized).toBe(false);

    const rows = await prisma.$queryRaw<Array<{
      id: string; state: string; approvalStatus: string | null;
      group: string; editorialTaskId: string | null; content: string;
      settings: string; receiptCount: bigint;
    }>>`
      SELECT p.id,p.state,p."approvalStatus",p."group",
             p."editorialTaskId",p.content,p.settings,
             (SELECT count(*) FROM "EditorialDraftReceipt" r
               WHERE r."postId"=p.id) AS "receiptCount"
      FROM "Post" p
      WHERE p."organizationId"=${org} AND p."editorialTaskId"=${task}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: postId, state: 'DRAFT', approvalStatus: 'pending',
      group: 'editorial-v1-' + postId, editorialTaskId: task,
      receiptCount: 1n, content: content.title + '\n\n' + content.parts[0],
    });
    expect(JSON.parse(rows[0].settings)).toMatchObject({
      __type: 'max', mode: 'story',
    });

    // No native scheduling even if approval is fabricated in a SQL update.
    await expect(prisma.$executeRaw`
      UPDATE "Post" SET state='QUEUE'
      WHERE id=${postId}`).rejects.toThrow();
    const [frozen] = await prisma.$queryRaw<Array<{ state: string }>>`
      SELECT state FROM "Post" WHERE id=${postId}`;
    expect(frozen.state).toBe('DRAFT');
  });

  it('rejects stolen scope, wrong credentials and changed text without writes', async () => {
    expect((await post(raw, 'Bearer edx_v1_' + 'b'.repeat(64))).status).toBe(401);
    expect((await read('Bearer edx_v1_' + 'b'.repeat(64))).status).toBe(401);
    expect((await post(JSON.stringify({ ...body, org_id: 'another-org' }))).status).toBe(403);
    expect((await post(JSON.stringify({
      ...body, content: { ...content, title: 'Изменено' },
    }))).status).toBe(400);
    const [n] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(*) AS total FROM "Post"
      WHERE "organizationId"=${org} AND "editorialTaskId"=${task}`;
    expect(n.total).toBe(1n);
  });

  it('installs Editor text once while retaining the initial receipt and frozen DRAFT', async () => {
    // Independent synthetic task; task 804 stays unchanged for human-review CI.
    const textTask = '805';
    const original = { ...body, task_id: textTask };
    const create = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(original),
    });
    expect(create.status).toBe(200);
    const initial = await create.json();
    const pid: string = initial.receipt.binding.post_id;
    const updated = {
      title: 'Редакторская версия',
      parts: ['П'.repeat(2800), 'В'.repeat(2850), 'Т'.repeat(2900)],
    };
    const pgJson = '{"parts": [' + updated.parts.map(p => JSON.stringify(p)).join(', ') +
      '], "title": ' + JSON.stringify(updated.title) + '}';
    const revisedHash = createHash('sha256').update(pgJson).digest('hex');
    const revised = {
      ...original, text: { revision: 1, sha256: revisedHash }, content: updated,
    };
    const install = () => fetch(url + '/' + textTask + '/install-text', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(revised),
    });
    const installed = await install();
    expect(installed.status).toBe(200);
    const result = await installed.json();
    expect(result.installed).toBe(true);
    expect(result.state).toBe('DRAFT');
    expect(result.native_verified).toBe(true);
    expect(result.receipt.binding.post_id).toBe(pid);
    expect(result.receipt.text.sha256).toBe(revisedHash);
    expect(result.receipt.publishable).toBe(false);

    const native = await prisma.post.findUniqueOrThrow({ where: { id: pid } });
    expect(native.state).toBe('DRAFT');
    expect(native.content).toBe(updated.title + '\n\n' + updated.parts[0]);
    expect(JSON.parse(native.settings ?? '{}').continuationText).toBe(
      updated.parts[1] + '\n────────────────────────\n' + updated.parts[2],
    );
    const receipt = await prisma.editorialDraftReceipt.findUniqueOrThrow({ where: { postId: pid } });
    const journal = await prisma.editorialTextInstall.findUniqueOrThrow({ where: { postId: pid } });
    expect((receipt.request as { content: unknown }).content).toEqual(content);
    expect((journal.request as { content: unknown }).content).toEqual(updated);
    expect(journal.sourceHash).toBe(digest);

    const get = await fetch(url + '/' + textTask, { headers: { authorization } });
    expect(get.status).toBe(200);
    expect((await get.json()).receipt.text.sha256).toBe(revisedHash);
    const replay = await install();
    expect(replay.status).toBe(200);
    expect((await replay.json()).installed).toBe(false);
    const obsolete = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify(original),
    });
    expect(obsolete.status).toBe(409);
    await expect(prisma.post.update({
      where: { id: pid }, data: { content: 'Unauthorized edit' },
    })).rejects.toThrow();
    await expect(prisma.post.update({
      where: { id: pid }, data: { state: 'QUEUE' },
    })).rejects.toThrow();
    await expect(prisma.editorialTextInstall.update({
      where: { postId: pid }, data: { sourceHash: '0'.repeat(64) },
    })).rejects.toThrow();
  });

  it('operates a human cookie/CSRF review against the real isolated DRAFT and SQL', async () => {
    // Reuse the full-51-migration disposable CI database and the exact
    // synthetic org/MAX target from this test, never a real MAX integration.
    const draftResponse = await post();
    expect(draftResponse.status).toBe(200);
    const draft = await draftResponse.json();
    const postId: string = draft.receipt.binding.post_id;
    expect(postId).toMatch(/^[0-9a-f]{32}$/);

    // The separate Editorial engine owns the initial state. Here we insert
    // its exact initial shape ONLY in the isolated test DB; production
    // requires the actual signed and identity-verified remote state.
    const initial = {
      binding: draft.receipt.binding,
      seq: '0', image_mode: 'disabled',
      text_status: 'pending', text_request_id: null,
      text: draft.receipt.text, image: null, image_compatible: false,
      image_intent: null, rejected: false, final_approved: false,
      dispatch_authorized: false, publishable: false,
    };
    const [anchor] = await prisma.$queryRaw<Array<{ value: Record<string, unknown> }>>`
      SELECT postmill_anchor_editorial_review_v1(
        ${JSON.stringify(scope)}::jsonb, ${task}::text, ${target}::text,
        ${JSON.stringify(initial)}::jsonb
      ) AS value`;
    expect(anchor.value).toMatchObject({
      created: true, dispatch_authorized: false, publishable: false,
    });

    // In this one runner-only Nest module, the real middleware and RBAC
    // guard are used. The synthetic resolver only supplies test identities;
    // it is NOT a replacement for production JWT validation.
    const roles = {
      getEffectivePermissions: vi.fn(async (_orgId: string, userId: string) => {
        // Foreign-org editor can have own-org rights; target allowlist
        // must still refuse the Postmill editorial endpoint.
        return userId === 'ci-viewer'
          ? { permissions: ['posts:read'] }
          : { permissions: ['posts:read', 'posts:update'] };
      }),
    };
    const audit = { record: vi.fn(async () => undefined) };
    const resolver = {
      resolve: vi.fn(async ({ jwt }: { jwt: string }) => ({
        ok: true,
        context: {
          org: { id: jwt === 'foreign' ? 'ci-foreign-org' : org },
          user: { id: jwt === 'viewer' ? 'ci-viewer' : 'ci-editor' },
          impersonated: false, expiresAt: null,
        },
      })),
    };
    const repository = Object.assign(Object.create(PostsRepository.prototype), {
      _post: prisma,
    }) as PostsRepository;
    class TestCookieAuth extends AuthMiddleware {
      constructor() { super(resolver as never); }
    }
    @Module({
      controllers: [EditorialHumanReviewController],
      providers: [
        EditorialHumanReviewService,
        { provide: PostsRepository, useValue: repository },
        { provide: RolesService, useValue: roles },
        { provide: AuditService, useValue: audit },
        // The guard is an enhancer attached by @UseGuards. Override that
        // enhancer in the isolated TestingModule, not just a provider token.
        { provide: EDITORIAL_HUMAN_REVIEW_CONFIG, useValue: {
          enabled: true, testOrgId: org, targetInternalId: target,
        } },
      ],
    })
    class IsolatedEditorModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TestCookieAuth).forRoutes(EditorialHumanReviewController);
        consumer.apply(CsrfMiddleware).forRoutes(EditorialHumanReviewController);
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [IsolatedEditorModule],
    }).overrideGuard(OrgRbacGuard).useValue(
      new OrgRbacGuard(new Reflector(), roles as never, audit as never),
    ).compile();
    const reviewApp = moduleRef.createNestApplication({ logger: ['error'] });
    reviewApp.use(cookieParser());
    await reviewApp.listen(0, '127.0.0.1');
    const route = (await reviewApp.getUrl()) + '/editorial/review/' + postId + '/' + task;
    const editorCookie = 'auth=editor; csrf_token=ci-test-csrf';
    const requestDecision = (payload: unknown, cookie = editorCookie,
      csrf = 'ci-test-csrf') => fetch(route + '/decisions', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify(payload),
    });
    const command = {
      command_id: '11111111-1111-4111-8111-111111111111',
      expected_seq: '0', action: 'approve_text', feedback: '',
    };

    try {
      const readResponse = await fetch(route, { headers: { cookie: editorCookie } });
      expect(readResponse.status).toBe(200);
      const snapshot = await readResponse.json();
      expect(snapshot).toMatchObject({
        post_id: postId, task_id: task, content,
        review_acknowledged: true,
        review: { status: 'idle', last_confirmed_state: { seq: '0' } },
        dispatch_authorized: false, publishable: false,
      });
      expect((await fetch(route, { headers: { cookie: 'auth=viewer' } })).status).toBe(200);
      expect((await requestDecision(command, 'auth=viewer; csrf_token=ci-test-csrf')).status).toBe(403);
      expect((await requestDecision(command, editorCookie, '')).status).toBe(403);
      expect((await fetch(route, { headers: { cookie: 'auth=foreign' } })).status).toBe(404);
      expect((await requestDecision({ ...command, actor_id: 'spoofed' })).status).toBe(400);
      expect((await requestDecision(command, 'csrf_token=ci-test-csrf')).status).toBe(403);

      const queuedResponse = await requestDecision(command);
      expect(queuedResponse.status).toBe(200);
      const queued = await queuedResponse.json();
      expect(queued).toMatchObject({
        status: 'queued/unconfirmed', newly_queued: true,
        publishable: false, dispatch_authorized: false,
      });
      expect(queued.event_id).toMatch(/^[0-9a-f-]{36}$/);
      const after = await (await fetch(route, { headers: { cookie: editorCookie } })).json();
      expect(after.review.status).toBe('pending');
      expect(after.review.last_confirmed_state.seq).toBe('0');

      // A second distinct command cannot jump over the pending delivery.
      const duplicate = await requestDecision({
        ...command, command_id: '22222222-2222-4222-8222-222222222222',
      });
      expect(duplicate.status).toBe(409);
      const [state] = await prisma.$queryRaw<Array<{
        state: string; approval: string | null;
        outbox: bigint; receipts: bigint;
      }>>`
        SELECT p.state,p."approvalStatus" AS approval,
          (SELECT count(*) FROM "EditorialDecisionOutbox" o WHERE o."postId"=p.id) AS outbox,
          (SELECT count(*) FROM "EditorialDecisionResult" r
            JOIN "EditorialDecisionOutbox" o ON o."eventId"=r."eventId"
            WHERE o."postId"=p.id) AS receipts
        FROM "Post" p WHERE p.id=${postId}`;
      expect(state).toEqual({
        state: 'DRAFT', approval: 'pending', outbox: 1n, receipts: 0n,
      });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'editorial.review.queued', resourceId: postId, userId: 'ci-editor',
      }));
    } finally {
      await reviewApp.close();
    }
  });

  it('09B: releases signed-approved three-part stories through one native Post per explicit command', async () => {
    // This is the same isolated full Prisma database and synthetic target
    // created in beforeAll. No Nest producer or MAX integration is called.
    async function importApproved(taskId: string, sourceId: string) {
      const [event] = await prisma.$queryRaw<Array<{
        eventId: string; payloadHash: string; payload: Record<string, unknown>;
        snapshot: Record<string, unknown>;
      }>>`
        SELECT o."eventId",o."payloadHash",o.payload,a.snapshot
        FROM "EditorialDecisionOutbox" o
        JOIN "EditorialReviewAnchor" a ON a."postId"=o."postId"
        WHERE o."postId"=${sourceId}
        ORDER BY o."createdAt" DESC LIMIT 1`;
      expect(event).toBeTruthy();
      const [next] = await prisma.$queryRaw<Array<{ state: Record<string, unknown> }>>`
        SELECT postmill_editorial_next_state_v1(
          ${JSON.stringify(event.snapshot)}::jsonb,
          ${JSON.stringify(event.payload)}::jsonb
        ) AS state`;
      expect(next.state).toMatchObject({ text_status: 'approved', final_approved: true });
      const reply = {
        status: 'accepted', reason: null, state: next.state,
        dispatch_authorized: false, publishable: false,
        newly_applied: true, replay: false,
      };
      const [result] = await prisma.$queryRaw<Array<{ value: Record<string, unknown> }>>`
        SELECT postmill_import_editorial_result_v1(
          ${JSON.stringify(scope)}::jsonb, ${taskId}::text, ${target}::text,
          ${event.eventId}::text, ${event.payloadHash}::text,
          ${JSON.stringify(reply)}::jsonb
        ) AS value`;
      expect(result.value).toMatchObject({
        newly_recorded: true, dispatch_authorized: false, publishable: false,
      });
    }

    const current = await (await post()).json();
    const sourceId = current.receipt.binding.post_id as string;
    // Earlier 08 test created this specific approve_text outbox, without a
    // confirmed remote result; approval alone must not release anything.
    const forbidden = {
      command_id: '33333333-3333-4333-8333-333333333333',
      action: 'publish_now', publish_at: null,
    };
    await expect(prisma.$queryRaw`
      SELECT postmill_release_editorial_story_v1(
        ${org}::text,${sourceId}::text,${task}::text,${target}::text,
        'ci-editor'::text,${JSON.stringify(forbidden)}::jsonb)`
    ).rejects.toThrow();
    await importApproved(task, sourceId);

    const [released] = await prisma.$queryRaw<Array<{ value: Record<string, unknown> }>>`
      SELECT postmill_release_editorial_story_v1(
        ${org}::text,${sourceId}::text,${task}::text,${target}::text,
        'ci-editor'::text,${JSON.stringify(forbidden)}::jsonb) AS value`;
    expect(released.value).toMatchObject({
      created: true, source_post_id: sourceId, mode: 'publish_now',
      status: 'queued_for_native_dispatch', publishable: false,
    });
    const publicationId = released.value.publication_post_id as string;
    expect(publicationId).toMatch(/^[0-9a-f]{32}$/);
    const [duplicate] = await prisma.$queryRaw<Array<{ value: Record<string, unknown> }>>`
      SELECT postmill_release_editorial_story_v1(
        ${org}::text,${sourceId}::text,${task}::text,${target}::text,
        'ci-editor'::text,${JSON.stringify(forbidden)}::jsonb) AS value`;
    expect(duplicate.value).toMatchObject({
      created: false, publication_post_id: publicationId,
    });
    await expect(prisma.$queryRaw`
      SELECT postmill_release_editorial_story_v1(
        ${org}::text,${sourceId}::text,${task}::text,${target}::text,
        'ci-editor'::text,${JSON.stringify({ ...forbidden,
          command_id: '44444444-4444-4444-8444-444444444444' })}::jsonb)`
    ).rejects.toThrow();

    const rows = await prisma.$queryRaw<Array<{
      id: string; state: string; content: string; settings: string;
      maxTarget: Record<string, unknown>;
      editorialTaskId: string | null; approvalStatus: string;
    }>>`SELECT id,state,content,settings,"maxTarget","editorialTaskId","approvalStatus"
       FROM "Post" WHERE id IN (${sourceId},${publicationId}) ORDER BY id`;
    expect(rows).toHaveLength(2);
    const source = rows.find(r => r.id === sourceId)!;
    const publishedCopy = rows.find(r => r.id === publicationId)!;
    expect(source.state).toBe('DRAFT');
    expect(source.editorialTaskId).toBe(task);
    expect(publishedCopy).toMatchObject({
      state: 'QUEUE', editorialTaskId: null, content: source.content,
      settings: source.settings, approvalStatus: 'approved',
    });
    expect(publishedCopy.maxTarget).toMatchObject({
      integrationId: integration, internalId: target,
    });
    expect(JSON.parse(publishedCopy.settings).continuationText).toContain('─');
    await expect(prisma.$executeRaw`UPDATE "Post" SET content='forged'
      WHERE id=${publicationId}`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE "Post" SET state='QUEUE'
      WHERE id=${sourceId}`).rejects.toThrow();
    await expect(prisma.$queryRaw`SELECT postmill_queue_editorial_human_v1(
      ${org}::text,${sourceId}::text,${task}::text,${target}::text,
      'ci-editor'::text,${JSON.stringify({
        command_id: '55555555-5555-4555-8555-555555555555',
        expected_seq: '1', action: 'reject', feedback: '',
      })}::jsonb)`).rejects.toThrow();

    // Second independent story on the same fake MAX channel uses exactly ONE
    // 08:00 Europe/Moscow slot, encoded as 05:00 UTC.
    const nextTask = '805';
    const secondDraft = await post(JSON.stringify({ ...body, task_id: nextTask }));
    expect(secondDraft.status).toBe(200);
    const next = await secondDraft.json();
    const nextId = next.receipt.binding.post_id as string;
    const nextInitial = {
      binding: next.receipt.binding, seq: '0', image_mode: 'disabled',
      text_status: 'pending', text_request_id: null, text: next.receipt.text,
      image: null, image_compatible: false, image_intent: null,
      rejected: false, final_approved: false,
      dispatch_authorized: false, publishable: false,
    };
    await prisma.$queryRaw`
      SELECT postmill_anchor_editorial_review_v1(
        ${JSON.stringify(scope)}::jsonb,${nextTask}::text,${target}::text,
        ${JSON.stringify(nextInitial)}::jsonb)`;
    await prisma.$queryRaw`
      SELECT postmill_queue_editorial_human_v1(
        ${org}::text,${nextId}::text,${nextTask}::text,${target}::text,
        'ci-editor'::text,${JSON.stringify({
          command_id: '66666666-6666-4666-8666-666666666666',
          expected_seq: '0', action: 'approve_text', feedback: '',
        })}::jsonb)`;
    await importApproved(nextTask, nextId);
    await prisma.$executeRaw`
      UPDATE "Integration" SET "postingTimes"='[{"time":300},{"time":600},{"time":1020}]'
      WHERE id=${integration}`;

    const scheduled = new Date();
    scheduled.setUTCDate(scheduled.getUTCDate() + 2);
    scheduled.setUTCHours(5, 0, 0, 0);
    const queueCommand = {
      command_id: '77777777-7777-4777-8777-777777777777',
      action: 'queue', publish_at: scheduled.toISOString(),
    };
    const [scheduledRelease] = await prisma.$queryRaw<Array<{ value: Record<string, unknown> }>>`
      SELECT postmill_release_editorial_story_v1(
        ${org}::text,${nextId}::text,${nextTask}::text,${target}::text,
        'ci-editor'::text,${JSON.stringify(queueCommand)}::jsonb) AS value`;
    expect(scheduledRelease.value).toMatchObject({
      created: true, mode: 'queue', publish_at: scheduled.toISOString(),
    });
    const queuedId = scheduledRelease.value.publication_post_id as string;
    const [scheduledPost] = await prisma.$queryRaw<Array<{
      state: string; publishDate: Date; settings: string;
    }>>`SELECT state,"publishDate",settings FROM "Post" WHERE id=${queuedId}`;
    expect(scheduledPost.state).toBe('QUEUE');
    expect(scheduledPost.publishDate.toISOString()).toBe(scheduled.toISOString());
    expect(JSON.parse(scheduledPost.settings).mode).toBe('story');
    const [total] = await prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT count(*) AS total FROM "EditorialRelease"
      WHERE "sourcePostId" IN (${sourceId},${nextId})`;
    expect(total.total).toBe(2n);
  });
});
