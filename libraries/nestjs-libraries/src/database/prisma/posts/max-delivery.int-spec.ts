import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  inject,
  vi,
} from 'vitest';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PostsRepository } from './posts.repository';
import { PostActivity } from '../../../inngest/activities/post.activity';

// Real PostgreSQL CAS + production activity, synthetic provider only.
const db = new PrismaClient({ datasources: { db: { url: inject('dbUrl') } } });
const org = 'max-recovery-test';
let repo: PostsRepository;
let migrated: any;
beforeAll(async () => {
  await db.organization.create({
    data: { id: org, name: 'Offline recovery test' },
  });
  for (const provider of ['max', 'telegram', 'vk'])
    await db.integration.create({
      data: {
        id: provider,
        organizationId: org,
        internalId: provider,
        name: provider,
        providerIdentifier: provider,
        type: 'social',
        token: 'synthetic-only',
      },
    });
  repo = new PostsRepository(
    { model: db } as any,
    null!,
    null!,
    null!,
    null!,
    null!,
    null!,
    null!,
    { model: db } as any,
  );
  const legacy = await createPost('max', 'PUBLISHING');
  // Simulate the old schema on this throwaway DB, then execute the exact migration.
  await db.$executeRawUnsafe('ALTER TABLE "Post" DROP COLUMN "maxDelivery"');
  const migration = readFileSync(
    new URL(
      '../migrations/20261112080000_max_delivery_guard/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const sql of migration
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await db.$executeRawUnsafe(sql);
  migrated = await db.post.findUniqueOrThrow({ where: { id: legacy.id } });
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await db.post.deleteMany({ where: { organizationId: org } });
});
async function createPost(provider = 'max', state: any = 'PUBLISHING') {
  return db.post.create({
    data: {
      organizationId: org,
      integrationId: provider,
      state,
      content: 'Synthetic text',
      group: crypto.randomUUID(),
      publishDate: new Date(Date.now() - 4 * 3600_000),
    },
  });
}
const receipt = (id: string) => ({
  id,
  postId: 'synthetic-mid',
  releaseURL: 'https://max.ru/test',
  status: 'completed',
});
function activity(
  post: any,
  send: any,
  confirmation = repo.confirmMaxDelivery.bind(repo),
) {
  const integration: any = {
    id: post.integrationId,
    organizationId: org,
    providerIdentifier: post.integrationId,
    internalId: '-123',
    token: 'synthetic-only',
  };
  const service = {
    updateTags: async () => [post],
    updateMedia: async () => [],
    beginMaxDelivery: repo.beginMaxDelivery.bind(repo),
    confirmMaxDelivery: confirmation,
  };
  const manager = {
    getSocialIntegration: async () => ({ editor: 'normal', post: send }),
    requireClientInformation: async () => ({}),
  };
  const a = new PostActivity(
    service as any,
    {} as any,
    manager as any,
    { getIntegrationById: async () => integration } as any,
    {} as any,
    {} as any,
    {} as any,
    { getVpnSelectionForIntegration: async () => null } as any,
    {} as any,
    {} as any,
    {} as any,
    { isDeleted: async () => false } as any,
  );
  return () => a.postSocial(integration, [post]);
}
async function stale(id: string) {
  await db.post.update({
    where: { id },
    data: { updatedAt: new Date(Date.now() - 4 * 3600_000) },
  });
}

describe('MAX crash recovery with PostgreSQL', () => {
  it('fails closed on a malformed confirmed journal instead of resending', async () => {
    const post = await createPost();
    await db.post.update({ where: { id: post.id }, data: { maxDelivery: { state: 'CONFIRMED', attempt: 1 } } });
    const send = vi.fn(async () => [receipt(post.id)]);
    await expect(activity(post, send)()).rejects.toThrow('operator review');
    expect(send).not.toHaveBeenCalled();
  });
  it('migration quarantines legacy attempts', () => {
    expect(migrated.state).toBe('ERROR');
    expect(migrated.maxDelivery.state).toBe('STARTED');
  });
  it('recovers guaranteed-unsent work and ordinary Telegram/VK claims normally', async () => {
    for (const provider of ['max', 'telegram', 'vk'])
      await createPost(provider);
    expect(await repo.resetStalePublishingToQueue()).toBe(3);
    expect(await db.post.count({ where: { state: 'QUEUE' } })).toBe(3);
  });
  it.each(['telegram', 'vk'])('keeps the ordinary %s activity path independent of the MAX journal', async provider => {
    const post = await createPost(provider); const send = vi.fn(async () => [receipt(post.id)]);
    await expect(activity(post, send)()).resolves.toHaveLength(1);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).maxDelivery).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('crash after external acceptance before receipt persistence never sends again', async () => {
    const post = await createPost();
    const send = vi.fn(async () => [receipt(post.id)]);
    const run = activity(post, send, async () => {
      throw Error('simulated DB outage after MAX acceptance');
    });
    await expect(run()).rejects.toThrow('DB outage');
    await stale(post.id);
    await repo.resetStalePublishingToQueue();
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state,
    ).toBe('ERROR');
    await expect(activity(post, send)()).rejects.toThrow('operator review');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('timeout remains uncertain and requires review', async () => {
    const post = await createPost();
    const send = vi.fn(async () => {
      throw Error('synthetic timeout');
    });
    await expect(activity(post, send)()).rejects.toThrow('timeout');
    await stale(post.id);
    await repo.resetStalePublishingToQueue();
    await expect(activity(post, send)()).rejects.toThrow('operator review');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('atomically saves receipt and completion; step replay returns receipt without POST', async () => {
    const post = await createPost();
    const send = vi.fn(async () => [receipt(post.id)]);
    const run = activity(post, send);
    expect(await run()).toEqual([receipt(post.id)]);
    expect(await run()).toEqual([receipt(post.id)]);
    const row = await db.post.findUniqueOrThrow({ where: { id: post.id } });
    expect(row.state).toBe('PUBLISHED');
    expect(row.releaseId).toBe('synthetic-mid');
    expect(JSON.stringify(row.maxDelivery)).not.toContain('synthetic-only');
    expect((row.maxDelivery as any).target).toMatchObject({ chatId: '-123', integrationId: 'max', textSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await repo.changeState(post.id, 'ERROR', org, 'late failed worker');
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state,
    ).toBe('PUBLISHED');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('lost acknowledgement after the receipt commit replays the persisted result', async () => {
    const post = await createPost();
    const send = vi.fn(async () => [receipt(post.id)]);
    await expect(
      activity(post, send, async (...args) => {
        await repo.confirmMaxDelivery(...args);
        throw Error('lost commit acknowledgement');
      })(),
    ).rejects.toThrow('lost commit');
    await expect(activity(post, send)()).resolves.toEqual([receipt(post.id)]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('concurrent activities admit only one external attempt', async () => {
    const post = await createPost();
    const send = vi.fn(async () => [receipt(post.id)]);
    const run = activity(post, send);
    await Promise.allSettled(Array.from({ length: 8 }, () => run()));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('crash immediately after marker is conservatively quarantined, even without a send', async () => {
    const post = await createPost();
    await repo.beginMaxDelivery(post.id, org);
    await stale(post.id);
    await repo.resetStalePublishingToQueue();
    expect(await repo.claimForPublish(post.id, org)).toBe(0);
  });
  it('manual authorization is org/attempt bound, single use and auditable', async () => {
    const post = await createPost();
    await repo.beginMaxDelivery(post.id, org);
    await stale(post.id);
    await repo.resetStalePublishingToQueue();
    expect(
      await repo.authorizeMaxRetry(post.id, 'other-org', 1, 'operator'),
    ).toBe(false);
    expect(await repo.authorizeMaxRetry(post.id, org, 99, 'operator')).toBe(
      false,
    );
    expect(await repo.authorizeMaxRetry(post.id, org, 1, 'operator')).toBe(
      true,
    );
    expect(await repo.authorizeMaxRetry(post.id, org, 1, 'operator')).toBe(
      false,
    );
    await repo.retryPost(post.id, org, new Date());
    await repo.claimForPublish(post.id, org);
    const send = vi.fn(async () => [receipt(post.id)]);
    await activity(post, send)();
    const journal = (
      await db.post.findUniqueOrThrow({ where: { id: post.id } })
    ).maxDelivery as any;
    expect(journal.attempt).toBe(2);
    expect(journal.history[0].reviewedBy).toBe('operator');
  });
});
