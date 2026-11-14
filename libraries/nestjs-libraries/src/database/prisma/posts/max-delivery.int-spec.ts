import { IntegrationRepository } from '../integrations/integration.repository';
import { AuthService } from '@postmill-ai/helpers/auth/auth.service';
import { maxTarget } from './max-target';
import { execFileSync } from 'node:child_process';
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
let imported: any;
let migrationDriftClean = false;
beforeAll(async () => {
  await db.organization.create({
    data: { id: org, name: 'Offline recovery test' },
  });
  for (const provider of ['max', 'telegram', 'vk'])
    await db.integration.create({
      data: {
        id: provider,
        organizationId: org,
        internalId: provider === 'max' ? '-123' : provider,
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
  const confirmed = await createPost('max', 'PUBLISHED');
  await db.post.update({
    where: { id: confirmed.id },
    data: {
      intervalInDays: 1,
      maxDelivery: {
        state: 'CONFIRMED',
        attempt: 2,
        receipt: receipt(confirmed.id),
        history: [{ attempt: 1, reviewedBy: 'legacy-operator' }],
      },
    },
  });
  const unsent = await createPost('max', 'QUEUE');
  await db.$executeRawUnsafe('DROP TABLE "MaxDeliveryAttempt"');
  await db.$executeRawUnsafe('DROP TABLE "MaxDeliveryOccurrence"');
  await db.$executeRawUnsafe(
    'ALTER TABLE "Post" DROP COLUMN "maxScheduleRevision"',
  );
  const occurrenceSql = readFileSync(
    new URL(
      '../migrations/20261112100000_max_occurrences/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const sql of occurrenceSql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe('ALTER TABLE "Post" DROP COLUMN "maxTarget"');
  const bindingSql = readFileSync(
    new URL(
      '../migrations/20261114090000_max_target_binding/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  for (const sql of bindingSql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((s) => s.trim()))
    await db.$executeRawUnsafe(sql);
  execFileSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-url',
      inject('dbUrl'),
      '--to-schema-datamodel',
      new URL('../schema.prisma', import.meta.url).pathname,
      '--exit-code',
    ],
    { stdio: 'pipe' },
  );
  migrationDriftClean = true;
  migrated = await db.post.findUniqueOrThrow({ where: { id: legacy.id } });
  const anchor = await repo.initialMaxOccurrence(confirmed.id, org);
  imported = {
    anchor,
    plan: await repo.planMaxOccurrence(confirmed.id, org, anchor.id),
    queued: await repo.initialMaxOccurrence(unsent.id, org),
  };
});
afterAll(async () => {
  await db.$disconnect();
});
beforeEach(async () => {
  await db.post.deleteMany({ where: { organizationId: org } });
});
async function createPost(provider = 'max', state: any = 'PUBLISHING') {
  const bound = await db.integration.findUniqueOrThrow({
    where: { id: provider },
  });
  return db.post.create({
    data: {
      organizationId: org,
      integrationId: provider,
      state,
      ...(bound.providerIdentifier === 'max'
        ? { maxTarget: maxTarget(bound) }
        : {}),
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
  occurrence?: string,
  expectedAttempt = 1,
) {
  const integration: any = {
    id: post.integrationId,
    organizationId: org,
    providerIdentifier: post.integrationId.startsWith('max')
      ? 'max'
      : post.integrationId,
    internalId: '-123',
    token: 'synthetic-only',
    providerVersion: 'v1',
    providerConfigId: null,
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
    {
      getIntegrationById: async (_org: string, id: string) =>
        db.integration.findUniqueOrThrow({ where: { id } }),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    { getVpnSelectionForIntegration: async () => null } as any,
    {} as any,
    {} as any,
    {} as any,
    { isDeleted: async () => false } as any,
  );
  return () => a.postSocial(integration, [post], occurrence, expectedAttempt);
}
async function stale(id: string) {
  await db.post.update({
    where: { id },
    data: { updatedAt: new Date(Date.now() - 4 * 3600_000) },
  });
}

describe('MAX occurrence recovery with PostgreSQL', () => {
  it('isolates one bot across two channels and two bots across separate channels', async () => {
    const configs = ['A', 'B'];
    for (const key of configs)
      await db.orgProviderConfiguration.upsert({
        where: { id: 'cfg' + key },
        update: { enabled: true },
        create: {
          id: 'cfg' + key,
          organizationId: org,
          identifier: 'max',
          name: key,
          enabled: true,
          clientId: 'fixture-config-' + key,
        },
      });
    const targets = [
      ['max-A', 'max:-101', 'fixture-bot-A', 'cfgA'],
      ['max-B', 'max:-102', 'fixture-bot-A', 'cfgA'],
      ['max-C', 'max:-103', 'fixture-bot-B', 'cfgB'],
    ];
    const send = vi.fn(async (_id, _token, payload) => [
      receipt(payload[0].id),
    ]);
    for (const [id, internalId, token, providerConfigId] of targets) {
      await db.integration.upsert({
        where: { id },
        update: { internalId, token, providerConfigId },
        create: {
          id,
          internalId,
          token,
          providerConfigId,
          organizationId: org,
          providerIdentifier: 'max',
          type: 'social',
          name: id,
        },
      });
      const post = await createPost(id, 'QUEUE');
      const o = await repo.initialMaxOccurrence(post.id, org);
      await activity(post, send, undefined, o.id)();
    }
    expect(send.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      targets.map((t) => [t[1], t[2]]),
    );
    expect(
      await db.maxDeliveryAttempt.count({
        where: { occurrence: { organizationId: org } },
      }),
    ).toBe(3);
  });
  it.each(['internalId', 'providerConfigId', 'token'])(
    'blocks a queued release after unexpected %s changes until explicit reschedule',
    async (field) => {
      const post = await createPost('max', 'QUEUE');
      const o = await repo.initialMaxOccurrence(post.id, org);
      if (field === 'providerConfigId')
        await db.orgProviderConfiguration.upsert({
          where: { id: 'retarget-config' },
          update: {},
          create: {
            id: 'retarget-config',
            organizationId: org,
            identifier: 'max',
            name: 'changed',
            enabled: true,
            clientId: 'fixture',
          },
        });
      const previous = await db.integration.findUniqueOrThrow({
        where: { id: 'max' },
      });
      try {
        await db.integration.update({
          where: { id: 'max' },
          data: {
            [field]:
              field === 'providerConfigId' ? 'retarget-config' : 'changed',
          },
        });
        expect(await repo.planMaxOccurrence(post.id, org, o.id)).toBeNull();
        expect(await repo.initialMaxOccurrence(post.id, org)).toBeNull();
        const send = vi.fn();
        await expect(activity(post, send, undefined, o.id)()).rejects.toThrow(
          'operator review',
        );
        expect(send).not.toHaveBeenCalled();
        await repo.changeMaxDate(
          org,
          post.id,
          new Date().toISOString(),
          false,
          'schedule',
        );
        const fresh = await repo.initialMaxOccurrence(post.id, org);
        expect(fresh.id).not.toBe(o.id);
        await activity(
          post,
          vi.fn(async () => [receipt(post.id)]),
          undefined,
          fresh.id,
        )();
      } finally {
        await db.integration.update({
          where: { id: 'max' },
          data: {
            internalId: previous.internalId,
            token: previous.token,
            providerConfigId: previous.providerConfigId,
          },
        });
      }
    },
  );
  it('rejects foreign organization claims and named config bindings', async () => {
    await db.organization.upsert({
      where: { id: 'foreign-org' },
      update: {},
      create: { id: 'foreign-org', name: 'foreign' },
    });
    await db.orgProviderConfiguration.upsert({
      where: { id: 'foreign-config' },
      update: {},
      create: {
        id: 'foreign-config',
        organizationId: 'foreign-org',
        identifier: 'max',
        name: 'foreign',
        enabled: true,
        clientId: 'fixture',
      },
    });
    const post = await createPost('max', 'QUEUE');
    const o = await repo.initialMaxOccurrence(post.id, org);
    expect(
      await repo.beginMaxDelivery(post.id, 'foreign-org', {}, o.id, 1),
    ).toBeNull();
    await db.integration.update({
      where: { id: 'max' },
      data: { providerConfigId: 'foreign-config' },
    });
    try {
      expect(await repo.planMaxOccurrence(post.id, org, o.id)).toBeNull();
    } finally {
      await db.integration.update({
        where: { id: 'max' },
        data: { providerConfigId: null },
      });
    }
  });

  async function due(parent: any) {
    const plan = await repo.planMaxOccurrence(parent.postId, org, parent.id);
    return plan!.next;
  }
  it('exact SQL migration matches the Prisma schema', () => {
    expect(migrationDriftClean).toBe(true);
  });
  it('imports the old journal and preserves legacy evidence', () => {
    expect(migrated.state).toBe('ERROR');
    expect(migrated.maxDelivery.state).toBe('STARTED');
  });
  it('legacy receipts/audit remain immutable anchors, not fabricated recurring releases', () => {
    expect(imported.anchor.state).toBe('CONFIRMED');
    expect(imported.anchor.legacy.history[0].reviewedBy).toBe(
      'legacy-operator',
    );
    expect(imported.plan.next).toBeNull();
    expect(imported.queued.state).toBe('READY');
  });
  it('publishes three independent sequential occurrences; replay never reuses a receipt as new success', async () => {
    const post = await createPost();
    await db.post.update({
      where: { id: post.id },
      data: {
        intervalInDays: 1,
        publishDate: new Date(Date.now() - 4 * 86400000),
      },
    });
    let occurrence = await repo.initialMaxOccurrence(post.id, org);
    const ids = new Set<string>();
    const send = vi.fn(async () => [
      { ...receipt(post.id), postId: `mid-${send.mock.calls.length}` },
    ]);
    for (let n = 0; n < 3; n++) {
      ids.add(occurrence.id);
      const next = await due(occurrence);
      await expect(
        activity(post, send, undefined, occurrence.id)(),
      ).resolves.toHaveLength(1);
      await expect(
        activity(post, send, undefined, occurrence.id)(),
      ).resolves.toEqual([]);
      const saved = await db.maxDeliveryOccurrence.findUniqueOrThrow({
        where: { id: occurrence.id },
      });
      expect(saved.state).toBe('CONFIRMED');
      expect((saved.receipt as any).postId).toBe(`mid-${n + 1}`);
      occurrence = next;
    }
    expect(ids.size).toBe(3);
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('an uncertain occurrence does not block the next scheduled occurrence', async () => {
    const post = await createPost();
    await db.post.update({
      where: { id: post.id },
      data: {
        intervalInDays: 1,
        publishDate: new Date(Date.now() - 4 * 86400000),
      },
    });
    const first = await repo.initialMaxOccurrence(post.id, org);
    const next = await due(first);
    const failed = vi.fn(async () => {
      throw Error('synthetic timeout');
    });
    await expect(activity(post, failed, undefined, first.id)()).rejects.toThrow(
      'timeout',
    );
    await repo.failMaxOccurrence(post.id, org, first.id);
    const send = vi.fn(async () => [receipt(post.id)]);
    await expect(activity(post, send, undefined, first.id)()).rejects.toThrow(
      'operator review',
    );
    await expect(
      activity(post, send, undefined, next.id)(),
    ).resolves.toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    await repo.failMaxOccurrence(post.id, org, first.id);
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state,
    ).toBe('PUBLISHED');
  });
  it('crash after acceptance before receipt persistence blocks only that occurrence', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    const send = vi.fn(async () => [receipt(post.id)]);
    await expect(
      activity(
        post,
        send,
        async () => {
          throw Error('DB unavailable');
        },
        o.id,
      )(),
    ).rejects.toThrow('DB unavailable');
    await db.maxDeliveryOccurrence.update({
      where: { id: o.id },
      data: { updatedAt: new Date(Date.now() - 4 * 3600000) },
    });
    await repo.pendingMaxOccurrences();
    expect(
      (
        await db.maxDeliveryOccurrence.findUniqueOrThrow({
          where: { id: o.id },
        })
      ).state,
    ).toBe('REVIEW');
    await expect(activity(post, send, undefined, o.id)()).rejects.toThrow(
      'operator review',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('commit acknowledgement loss cannot resend or report another success', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    const send = vi.fn(async () => [receipt(post.id)]);
    await expect(
      activity(
        post,
        send,
        async (...args) => {
          await repo.confirmMaxDelivery(...args);
          throw Error('lost acknowledgement');
        },
        o.id,
      )(),
    ).rejects.toThrow('lost acknowledgement');
    await expect(activity(post, send, undefined, o.id)()).resolves.toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state,
    ).toBe('PUBLISHED');
  });
  it('eight parallel activities admit a single attempt', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    const send = vi.fn(async () => [receipt(post.id)]);
    await Promise.allSettled(
      Array.from({ length: 8 }, () => activity(post, send, undefined, o.id)()),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.maxDeliveryAttempt.count({ where: { occurrenceId: o.id } }),
    ).toBe(1);
  });
  it('operator retry is bound to occurrence, attempt and organization, with normalized audit', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    await repo.beginMaxDelivery(post.id, org, {}, o.id, 1);
    await repo.failMaxOccurrence(post.id, org, o.id);
    expect(
      await repo.authorizeMaxRetry(post.id, org, 99, 'operator', o.id),
    ).toBe(false);
    expect(
      await repo.authorizeMaxRetry(post.id, org, 1, 'operator', 'wrong'),
    ).toBe(false);
    expect(
      await repo.authorizeMaxRetry(post.id, org, 1, 'operator', o.id),
    ).toBe(true);
    expect(
      await repo.authorizeMaxRetry(post.id, org, 1, 'operator', o.id),
    ).toBe(false);
    const staleSend = vi.fn();
    await expect(
      activity(post, staleSend, undefined, o.id, 1)(),
    ).rejects.toThrow('operator review');
    expect(staleSend).not.toHaveBeenCalled();
    await activity(
      post,
      vi.fn(async () => [receipt(post.id)]),
      undefined,
      o.id,
      2,
    )();
    const rows = await repo.listMaxOccurrences(post.id, org);
    expect(rows[0].attempts).toHaveLength(2);
    expect(rows[0].attempts[0].reviewedBy).toBe('operator');
    expect(await repo.listMaxOccurrences(post.id, 'other-org')).toEqual([]);
  });
  it.each(['content', 'intervalInDays', 'publishDate', 'integrationId'])(
    'invalidates pending old events after editing %s',
    async (field) => {
      const post = await createPost();
      const old = await repo.initialMaxOccurrence(post.id, org);
      const changes: any = {
        content: 'Changed text',
        intervalInDays: 2,
        publishDate: new Date(Date.now() + 86400000),
        integrationId: 'max-other',
      };
      if (field === 'integrationId')
        await db.integration.upsert({
          where: { id: 'max-other' },
          update: {},
          create: {
            id: 'max-other',
            organizationId: org,
            internalId: 'other',
            name: 'MAX other',
            providerIdentifier: 'max',
            type: 'social',
            token: 'synthetic',
          },
        });
      await db.post.update({
        where: { id: post.id },
        data: { [field]: changes[field] },
      });
      expect(await repo.planMaxOccurrence(post.id, org, old.id)).toBeNull();
      if (field === 'integrationId')
        expect(await repo.initialMaxOccurrence(post.id, org)).toBeNull();
      else
        expect((await repo.initialMaxOccurrence(post.id, org)).id).not.toBe(
          old.id,
        );
      await expect(
        activity(post, vi.fn(), undefined, old.id)(),
      ).rejects.toThrow('operator review');
    },
  );
  it('a cached MAX activity cannot send after the post changes to another provider', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    await db.post.update({
      where: { id: post.id },
      data: { integrationId: 'telegram' },
    });
    const send = vi.fn(async () => [receipt(post.id)]);
    await expect(activity(post, send, undefined, o.id)()).rejects.toThrow(
      'operator review',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('pause/resume creates a new schedule revision; stale occurrence identities remain cancelled', async () => {
    const post = await createPost();
    const old = await repo.initialMaxOccurrence(post.id, org);
    await db.post.update({ where: { id: post.id }, data: { state: 'DRAFT' } });
    await repo.pauseMaxOccurrences(post.id, org);
    await db.post.update({ where: { id: post.id }, data: { state: 'QUEUE' } });
    const next = await repo.initialMaxOccurrence(post.id, org);
    expect(next.id).not.toBe(old.id);
    expect(await repo.planMaxOccurrence(post.id, org, old.id)).toBeNull();
    const send = vi.fn(async () => [receipt(post.id)]);
    await activity(post, send, undefined, next.id)();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('per-occurrence webhooks use the delivered snapshot, never a later edited template', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    await activity(
      post,
      vi.fn(async () => [receipt(post.id)]),
      undefined,
      o.id,
    )();
    await db.post.update({
      where: { id: post.id },
      data: { content: 'Never sent content' },
    });
    const snapshot = await repo.maxWebhookSnapshot(post.id, org, o.id);
    expect(snapshot.content).toBe('Synthetic text');
    expect(snapshot.releaseURL).toBe(receipt(post.id).releaseURL);
    expect(
      await repo.maxWebhookSnapshot(post.id, 'other-org', o.id),
    ).toBeNull();
  });
  it('cancellation during an in-flight attempt retains its receipt without unpausing the template', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    const send = vi.fn(async () => {
      await db.post.update({
        where: { id: post.id },
        data: { state: 'DRAFT' },
      });
      await repo.pauseMaxOccurrences(post.id, org);
      return [receipt(post.id)];
    });
    await activity(post, send, undefined, o.id)();
    expect(
      (
        await db.maxDeliveryOccurrence.findUniqueOrThrow({
          where: { id: o.id },
        })
      ).state,
    ).toBe('CONFIRMED');
    expect(
      (await db.post.findUniqueOrThrow({ where: { id: post.id } })).state,
    ).toBe('DRAFT');
  });
  it('pause cancels pending occurrences and recovery never resurrects them', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    await db.post.update({ where: { id: post.id }, data: { state: 'DRAFT' } });
    expect(await repo.planMaxOccurrence(post.id, org, o.id)).toBeNull();
    expect(await repo.pendingMaxOccurrences()).toEqual([]);
  });
  it('recovery returns unsent occurrences and never uncertain ones', async () => {
    const post = await createPost();
    const o = await repo.initialMaxOccurrence(post.id, org);
    expect((await repo.pendingMaxOccurrences()).map((x) => x.id)).toContain(
      o.id,
    );
    await repo.beginMaxDelivery(post.id, org, {}, o.id, 1);
    await db.maxDeliveryOccurrence.update({
      where: { id: o.id },
      data: { updatedAt: new Date(Date.now() - 4 * 3600000) },
    });
    expect((await repo.pendingMaxOccurrences()).map((x) => x.id)).not.toContain(
      o.id,
    );
  });
  it('recovers a crash after QUEUE commit but before journal initialization, without duplicate attempts', async () => {
    const post = await createPost('max', 'QUEUE');
    const draft = await createPost('max', 'DRAFT');
    const published = await createPost('max', 'PUBLISHED');
    const ordinary = await createPost('telegram', 'QUEUE');
    const sweeps = await Promise.all([
      repo.pendingMaxOccurrences(),
      repo.pendingMaxOccurrences(),
    ]);
    const o = await db.maxDeliveryOccurrence.findFirstOrThrow({
      where: { postId: post.id },
    });
    expect(sweeps.every((rows) => rows.some((row) => row.id === o.id))).toBe(
      true,
    );
    expect(o.state).toBe('READY');
    expect(o.attempt).toBe(0);
    expect(
      await db.maxDeliveryOccurrence.count({
        where: { postId: { in: [draft.id, published.id, ordinary.id] } },
      }),
    ).toBe(0);
    const send = vi.fn(async () => [receipt(post.id)]);
    const results = await Promise.allSettled([
      activity(post, send, undefined, o.id)(),
      activity(post, send, undefined, o.id)(),
    ]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.maxDeliveryOccurrence.count({ where: { postId: post.id } }),
    ).toBe(1);
    expect(
      (
        await db.maxDeliveryOccurrence.findUniqueOrThrow({
          where: { id: o.id },
        })
      ).state,
    ).toBe('CONFIRMED');
  });
  it('initialization recovery preserves an uncertain legacy guard on a queued post', async () => {
    const post = await createPost('max', 'QUEUE');
    await db.post.update({
      where: { id: post.id },
      data: { maxDelivery: { state: 'STARTED', attempt: 1 } },
    });
    expect(await repo.pendingMaxOccurrences()).toEqual([]);
    const o = await db.maxDeliveryOccurrence.findFirstOrThrow({
      where: { postId: post.id },
    });
    expect(o.state).toBe('REVIEW');
    expect(o.attempt).toBe(1);
  });
  it('long series uses separate rows, bounded Post summary and one child per parent', async () => {
    const post = await createPost();
    await db.post.update({
      where: { id: post.id },
      data: {
        intervalInDays: 1,
        publishDate: new Date(Date.now() - 40 * 86400000),
      },
    });
    let o = await repo.initialMaxOccurrence(post.id, org);
    for (let n = 0; n < 25; n++) {
      const [a, b] = await Promise.all([due(o), due(o)]);
      expect(a.id).toBe(b.id);
      o = a;
    }
    expect(
      await db.maxDeliveryOccurrence.count({ where: { postId: post.id } }),
    ).toBe(26);
  });
  it.each(['telegram', 'vk'])(
    'ordinary %s claims and recovery remain unchanged',
    async (provider) => {
      const post = await createPost(provider);
      expect(await repo.resetStalePublishingToQueue()).toBe(1);
      expect(await repo.claimForPublish(post.id, org)).toBe(1);
      const send = vi.fn(async () => [receipt(post.id)]);
      await activity(post, send)();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('freezes the target in the original save before journal initialization; only scheduling rebinds', async () => {
    const productionRepo = new (PostsRepository as any)(
      ...Array.from({ length: 9 }, () => ({ model: db })),
    );
    const body: any = {
      integration: { id: 'max' },
      settings: { __type: 'max' },
      value: [{ content: 'Saved through repository', image: [] }],
    };
    const {
      posts: [saved],
    } = await productionRepo.createOrUpdatePost(
      'schedule',
      org,
      new Date().toISOString(),
      body,
      [],
      'WEB',
    );
    const original = await db.post.findUniqueOrThrow({
      where: { id: saved.id },
    });
    expect(original.maxTarget).toEqual(
      maxTarget(
        await db.integration.findUniqueOrThrow({ where: { id: 'max' } }),
      ),
    );
    expect(
      await db.maxDeliveryOccurrence.count({ where: { postId: saved.id } }),
    ).toBe(0);
    const firstIntent = await repo.initialMaxOccurrence(saved.id, org);
    await repo.beginMaxDelivery(saved.id, org, {}, firstIntent.id, 1);
    await repo.failMaxOccurrence(saved.id, org, firstIntent.id);
    const frozenAttempt = await db.maxDeliveryAttempt.findFirstOrThrow({
      where: { occurrenceId: firstIntent.id },
    });
    expect((frozenAttempt.target as any).tokenHash).toBe(
      (original.maxTarget as any).tokenHash,
    );
    const integration = await db.integration.findUniqueOrThrow({
      where: { id: 'max' },
    });
    try {
      await db.integration.update({
        where: { id: 'max' },
        data: { token: 'different-synthetic-bot' },
      });
      body.value[0].id = saved.id;
      await productionRepo.createOrUpdatePost(
        'update',
        org,
        new Date().toISOString(),
        body,
        [],
        'WEB',
      );
      expect(
        (await db.post.findUniqueOrThrow({ where: { id: saved.id } }))
          .maxTarget,
      ).toEqual(original.maxTarget);
      expect(await repo.initialMaxOccurrence(saved.id, org)).toBeNull();
      await productionRepo.createOrUpdatePost(
        'schedule',
        org,
        new Date().toISOString(),
        body,
        [],
        'WEB',
      );
      expect(
        (await db.post.findUniqueOrThrow({ where: { id: saved.id } }))
          .maxScheduleRevision,
      ).toBe(1);
      expect(await repo.initialMaxOccurrence(saved.id, org)).not.toBeNull();
      expect(
        (
          await db.maxDeliveryAttempt.findUniqueOrThrow({
            where: { id: frozenAttempt.id },
          })
        ).target,
      ).toEqual(frozenAttempt.target);
    } finally {
      await db.integration.update({
        where: { id: 'max' },
        data: { token: integration.token },
      });
    }
  });
  it('encrypts MAX credentials and atomically refuses to overwrite another provider identity', async () => {
    const integrations = new (IntegrationRepository as any)(
      ...Array.from({ length: 4 }, () => ({ model: db })),
    );
    const saved = await integrations.createOrUpdateIntegration(
      undefined,
      false,
      org,
      'Synthetic connection',
      undefined,
      'social',
      'max:-901',
      'max',
      'synthetic-bot-secret',
    );
    expect(saved.token).not.toBe('synthetic-bot-secret');
    expect(AuthService.fixedDecryption(saved.token)).toBe(
      'synthetic-bot-secret',
    );
    await expect(
      integrations.createOrUpdateIntegration(
        undefined,
        false,
        org,
        'Collision',
        undefined,
        'social',
        'telegram',
        'max',
        'synthetic-bot-secret',
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(
      (await db.integration.findUniqueOrThrow({ where: { id: 'telegram' } }))
        .providerIdentifier,
    ).toBe('telegram');
  });
  it('recovers a reschedule committed before the new initial journal despite confirmed old history', async () => {
    const post = await createPost();
    const old = await repo.initialMaxOccurrence(post.id, org);
    await repo.beginMaxDelivery(post.id, org, {}, old.id, 1);
    await repo.confirmMaxDelivery(post.id, org, 1, receipt(post.id), old.id);
    await repo.changeMaxDate(
      org,
      post.id,
      new Date(Date.now() - 1000).toISOString(),
      false,
      'schedule',
    );
    await Promise.all([
      repo.pendingMaxOccurrences(),
      repo.pendingMaxOccurrences(),
    ]);
    const rows = await repo.listMaxOccurrences(post.id, org);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === old.id)?.state).toBe('CONFIRMED');
    const fresh = rows.find((row) => row.id !== old.id)!;
    expect(fresh.state).toBe('READY');
    const send = vi.fn(async () => [receipt(post.id)]);
    await activity(post, send, undefined, fresh.id, 1)();
    await expect(activity(post, send, undefined, fresh.id, 1)()).resolves.toEqual([]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (await repo.listMaxOccurrences(post.id, org)).filter(
        (row) => row.state === 'CONFIRMED',
      ),
    ).toHaveLength(2);
  });
});
