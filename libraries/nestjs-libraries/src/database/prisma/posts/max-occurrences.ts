import { createHash } from 'node:crypto';

// Repository-owned SQL boundary; every transition locks the parent post before
// checking the schedule revision. No lock spans provider HTTP.
export class MaxOccurrences {
  constructor(private db: any) {}
  private async locked<T>(
    postId: string,
    org: string,
    action: (tx: any, post: any) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(async (tx: any) => {
      await tx.$queryRaw`SELECT id FROM "Post" WHERE id=${postId} AND "organizationId"=${org} FOR UPDATE`;
      const post = await tx.post.findFirst({
        where: { id: postId, organizationId: org },
        include: { integration: true },
      });
      if (!post)
        return null as T;
      return action(tx, post);
    });
  }
  private fingerprint(p: any) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          p.maxScheduleRevision,
          p.publishDate.toISOString(),
          p.intervalInDays,
          p.content,
          p.image,
          p.settings,
          p.integrationId,
          p.integration.internalId,
          p.integration.providerVersion,
          p.campaignId,
        ]),
      )
      .digest('hex');
  }
  private async hydrate(tx: any, o: any) {
    if (o && !o.fingerprint && o.legacy?.template) {
      const old = o.legacy.template;
      return tx.maxDeliveryOccurrence.update({
        where: { id: o.id },
        data: {
          fingerprint: this.fingerprint({
            ...old,
            publishDate: new Date(old.publishDate),
          }),
        },
      });
    }
    return o;
  }
  private active(p: any) {
    return (
      p.integration.providerIdentifier === 'max' && !p.deletedAt &&
      p.state !== 'DRAFT' &&
      !p.integration.disabled &&
      !p.integration.deletedAt
    );
  }
  private summary(o: any) {
    return {
      occurrenceId: o.id,
      state: o.state === 'REVIEW' ? 'STARTED' : o.state,
      attempt: o.attempt,
      ...(o.receipt ? { receipt: o.receipt } : {}),
    };
  }
  async initial(postId: string, org: string, resume = true) {
    return this.locked(postId, org, async (tx, p) => {
      if (!this.active(p)) return null;
      let fingerprint = this.fingerprint(p);
      // Imported journals remain the original occurrence, never a new send.
      const legacyId =
        p.maxDelivery?.occurrenceId ||
        (p.maxDelivery ? `max_legacy_${postId}` : undefined);
      if (legacyId?.startsWith('max_legacy_')) {
        let legacy = await tx.maxDeliveryOccurrence.findFirst({
          where: { id: legacyId, postId },
        });
        if (!legacy) {
          const old = p.maxDelivery;
          const validReceipt =
            old?.state === 'CONFIRMED' &&
            old.receipt?.id === postId &&
            old.receipt?.postId;
          legacy = await tx.maxDeliveryOccurrence.create({
            data: {
              id: legacyId,
              postId,
              organizationId: org,
              scheduledAt: p.publishDate,
              fingerprint,
              state: validReceipt
                ? 'CONFIRMED'
                : old?.state === 'READY'
                  ? 'READY'
                  : 'REVIEW',
              attempt: old.attempt ?? 0,
              legacy: old,
              ...(validReceipt ? { receipt: old.receipt } : {}),
            },
          });
        }
        if (!legacy.fingerprint) {
          const old = legacy.legacy?.template;
          legacy = await tx.maxDeliveryOccurrence.update({
            where: { id: legacy.id },
            data: {
              fingerprint: old
                ? this.fingerprint({
                    ...old,
                    publishDate: new Date(old.publishDate),
                  })
                : fingerprint,
            },
          });
        }
        if (legacy.fingerprint === fingerprint) return legacy;
      }
      let id =
        'max_' +
        createHash('sha256')
          .update(postId + fingerprint + ':initial')
          .digest('hex');
      if (
        resume &&
        (await tx.maxDeliveryOccurrence.count({
          where: { postId, fingerprint, state: 'CANCELLED' },
        }))
      ) {
        p.maxScheduleRevision++;
        await tx.post.update({
          where: { id: postId },
          data: { maxScheduleRevision: p.maxScheduleRevision },
        });
        fingerprint = this.fingerprint(p);
        id =
          'max_' +
          createHash('sha256')
            .update(postId + fingerprint + ':initial')
            .digest('hex');
      }
      return tx.maxDeliveryOccurrence.upsert({
        where: { id },
        update: {},
        create: {
          id,
          postId,
          organizationId: org,
          scheduledAt: p.publishDate,
          fingerprint,
        },
      });
    });
  }
  async plan(postId: string, org: string, id: string) {
    return this.locked(postId, org, async (tx, p) => {
      const current = await this.hydrate(
        tx,
        await tx.maxDeliveryOccurrence.findFirst({
          where: { id, postId, organizationId: org },
        }),
      );
      if (!current) return null;
      if (!this.active(p) || current.fingerprint !== this.fingerprint(p)) {
        await tx.maxDeliveryOccurrence.update({
          where: { id },
          data: {
            continued: true,
            ...(current.state === 'READY' ? { state: 'CANCELLED' } : {}),
          },
        });
        return null;
      }
      let next = null;
      if (
        !current.legacy &&
        p.intervalInDays > 0 &&
        current.state !== 'CANCELLED'
      ) {
        const nextId =
          'max_' +
          createHash('sha256')
            .update(id + ':next')
            .digest('hex');
        next = await tx.maxDeliveryOccurrence.upsert({
          where: { id: nextId },
          update: {},
          create: {
            id: nextId,
            postId,
            organizationId: org,
            parentId: id,
            fingerprint: current.fingerprint,
            scheduledAt: new Date(
              current.scheduledAt.getTime() + p.intervalInDays * 86400000,
            ),
          },
        });
      }
      await tx.maxDeliveryOccurrence.update({
        where: { id },
        data: { continued: true },
      });
      return { current, next };
    });
  }
  async begin(
    postId: string,
    org: string,
    id: string | undefined,
    target: any,
    expectedAttempt?: number,
  ): Promise<{
    blocked?: boolean;
    alreadyConfirmed?: boolean;
    occurrenceId?: string;
    attempt?: number;
  }> {
    if (!id) return { blocked: true };
    return this.locked(postId, org, async (tx, p) => {
      const o = await this.hydrate(
        tx,
        await tx.maxDeliveryOccurrence.findFirst({
          where: { id, postId, organizationId: org },
        }),
      );
      if (!o || !this.active(p) || o.fingerprint !== this.fingerprint(p))
        return { blocked: true };
      // Already-confirmed is a no-op, never a fresh success for a duplicate run.
      if (o.state === 'CONFIRMED')
        return { alreadyConfirmed: true, occurrenceId: id };
      if (o.state !== 'READY' || o.scheduledAt > new Date() || !Number.isInteger(expectedAttempt) || expectedAttempt !== o.attempt + 1)
        return { blocked: true };
      const attempt = o.attempt + 1;
      await tx.maxDeliveryOccurrence.update({
        where: { id },
        data: { state: 'STARTED', attempt },
      });
      await tx.maxDeliveryAttempt.create({
        data: { occurrenceId: id, number: attempt, state: 'STARTED', target },
      });
      await tx.post.update({
        where: { id: postId },
        data: {
          state: 'PUBLISHING',
          error: null,
          maxDelivery: { occurrenceId: id, state: 'STARTED', attempt },
        },
      });
      return { attempt, occurrenceId: id };
    });
  }
  async confirm(
    postId: string,
    org: string,
    id: string,
    attempt: number,
    receipt: any,
  ) {
    return this.locked(postId, org, async (tx, p) => {
      const o = await tx.maxDeliveryOccurrence.findFirst({
        where: { id, postId, organizationId: org },
      });
      if (
        !o ||
        !['STARTED', 'REVIEW'].includes(o.state) ||
        o.attempt !== attempt
      )
        throw Error('MAX occurrence receipt conflict');
      await tx.maxDeliveryOccurrence.update({
        where: { id },
        data: { state: 'CONFIRMED', receipt },
      });
      await tx.maxDeliveryAttempt.update({
        where: { occurrenceId_number: { occurrenceId: id, number: attempt } },
        data: { state: 'CONFIRMED', receipt },
      });
      if (
        p.maxDelivery?.occurrenceId === id &&
        this.active(p) &&
        o.fingerprint === this.fingerprint(p)
      )
        await tx.post.update({
          where: { id: postId },
          data: {
            state: 'PUBLISHED',
            releaseId: receipt.postId,
            releaseURL: receipt.releaseURL,
            error: null,
            maxDelivery: this.summary({ ...o, state: 'CONFIRMED', receipt }),
          },
        });
    });
  }
  async fail(postId: string, org: string, id: string) {
    return this.locked(postId, org, async (tx, p) => {
      const o = await tx.maxDeliveryOccurrence.findFirst({
        where: { id, postId, organizationId: org },
      });
      if (!o || !['STARTED', 'REVIEW'].includes(o.state)) return;
      await tx.maxDeliveryOccurrence.update({
        where: { id },
        data: { state: 'REVIEW' },
      });
      await tx.maxDeliveryAttempt.updateMany({
        where: { occurrenceId: id, number: o.attempt, state: 'STARTED' },
        data: { state: 'REVIEW' },
      });
      if (
        p.maxDelivery?.occurrenceId === id &&
        this.active(p) &&
        o.fingerprint === this.fingerprint(p)
      )
        await tx.post.update({
          where: { id: postId },
          data: {
            state: 'ERROR',
            error: 'MAX occurrence delivery unknown: operator review required',
            maxDelivery: this.summary({ ...o, state: 'REVIEW' }),
          },
        });
    });
  }
  async authorize(
    postId: string,
    org: string,
    id: string,
    attempt: number,
    actor: string,
  ) {
    return this.locked(postId, org, async (tx, p) => {
      let o = await tx.maxDeliveryOccurrence.findFirst({
        where: { id, postId, organizationId: org },
      });
      if (o && !o.fingerprint && o.legacy?.template) {
        const old = o.legacy.template;
        o = await tx.maxDeliveryOccurrence.update({
          where: { id },
          data: {
            fingerprint: this.fingerprint({
              ...old,
              publishDate: new Date(old.publishDate),
            }),
          },
        });
      }
      if (
        !o ||
        o.state !== 'REVIEW' ||
        o.attempt !== attempt ||
        !this.active(p) ||
        o.fingerprint !== this.fingerprint(p)
      )
        return false;
      await tx.maxDeliveryAttempt.update({
        where: { occurrenceId_number: { occurrenceId: id, number: attempt } },
        data: {
          state: 'RETRY_AUTHORIZED',
          reviewedBy: actor,
          reviewedAt: new Date(),
        },
      });
      await tx.maxDeliveryOccurrence.update({
        where: { id },
        data: { state: 'READY' },
      });
      return true;
    });
  }
  async webhookSnapshot(postId: string, org: string, id: string) {
    return this.db.$transaction(async (tx: any) => {
      const o = await tx.maxDeliveryOccurrence.findFirst({
        where: { id, postId, organizationId: org, state: 'CONFIRMED' },
      });
      if (!o?.receipt?.postId) return null;
      const attempt = await tx.maxDeliveryAttempt.findUnique({
        where: { occurrenceId_number: { occurrenceId: id, number: o.attempt } },
      });
      if (typeof attempt?.target?.content !== 'string') return null;
      return {
        id: postId,
        content: attempt.target.content,
        releaseURL: o.receipt.releaseURL,
        state: 'PUBLISHED',
        publishDate: o.scheduledAt,
        occurrenceId: id,
        integration: {
          providerIdentifier: 'max',
          name: attempt.target.integrationName,
        },
      };
    });
  }
  async pause(postId: string, org: string) {
    return this.locked(postId, org, async (tx, p) => {
      await tx.post.update({
        where: { id: postId },
        data: { maxScheduleRevision: { increment: 1 } },
      });
      await tx.maxDeliveryOccurrence.updateMany({
        where: { postId, state: 'READY' },
        data: { state: 'CANCELLED', continued: true },
      });
    });
  }
  async list(postId: string, org: string, cursor?: string) {
    return this.db.$transaction((tx: any) =>
      tx.maxDeliveryOccurrence.findMany({
        where: { postId, organizationId: org },
        orderBy: { id: 'asc' },
        take: 50,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { attempts: { orderBy: { number: 'asc' } } },
      }),
    );
  }
  async pending() {
    const stale = await this.db.$transaction((tx: any) =>
      tx.maxDeliveryOccurrence.findMany({
        where: {
          state: 'STARTED',
          updatedAt: { lt: new Date(Date.now() - 3 * 3600000) },
        },
      }),
    );
    for (const o of stale) await this.fail(o.postId, o.organizationId, o.id);
    const ready = await this.db.$transaction((tx: any) =>
      tx.maxDeliveryOccurrence.findMany({
        where: {
          OR: [
            { state: 'READY' },
            { continued: false, state: { in: ['REVIEW', 'CONFIRMED'] } },
          ],
          scheduledAt: { lte: new Date() },
        },
      }),
    );
    const result: any[] = [];
    for (const o of ready) {
      const plan = await this.plan(o.postId, o.organizationId, o.id);
      if (!plan) continue;
      // Terminal runs may die before checkpointing successor dispatch. Re-emit
      // its stable identity; PostgreSQL remains authoritative beyond dedup TTL.
      if (o.state === 'READY') result.push(o);
      if (plan.next?.state === 'READY') result.push(plan.next);
    }
    return result;
  }
}
