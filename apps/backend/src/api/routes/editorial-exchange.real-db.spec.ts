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
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { EditorialExchangeService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-exchange.service';
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
});
