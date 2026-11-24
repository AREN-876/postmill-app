import { Inject, Injectable } from '@nestjs/common';
import { PostsRepository } from './posts.repository';
import { type EditorialScope } from './editorial-ingress';
import {
  editorialPending, editorialWireConfig, editorialLoopbackFetch, EditorialTransportError,
  signedEditorialRequest, type EditorialWireConfig,
} from './editorial-signed-transport';

// Used by the isolated, default-off editorial Inngest activity. It reserves
// primary submit durably; recovery additionally requires signed absence and a separate reservation.
// Human commands must first pass cookie/CSRF/RBAC and be persisted in Postmill;
// this service cannot grant native publication or paid AI execution.
export type EditorialDeliveryConfig = EditorialWireConfig & {
  allowMissingRecovery?: boolean;
};

@Injectable()
export class EditorialDeliveryService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository) {}

  // Read-only lookup may run without a send reservation; primary submit may not.
  async reconcileOnce(scope: EditorialScope, task: string, target: string,
    config: EditorialWireConfig, fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch) {
    const peer = editorialWireConfig(config);
    if (scope.org_id !== peer.orgId || scope.is_test !== true) {
      throw new EditorialTransportError();
    }
    const raw = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (raw === null) return { status: 'no_pending' as const };
    const pending = editorialPending(raw, scope.org_id, task);
    const remote = await signedEditorialRequest(pending, config, 'lookup', fetcher);
    if (remote.found !== true || remote.outcome === null) {
      // Unknown is not rejected. Do not submit/retry as a side effect.
      return { status: 'unknown' as const };
    }
    const recorded = await this.posts.importEditorialDecisionResult(
      scope, task, target, pending.event_id, pending.payload_sha256,
      remote.outcome as Parameters<PostsRepository['importEditorialDecisionResult']>[5],
    );
    return { status: 'recorded' as const, receipt: recorded };
  }
  // A committed reservation is required for any submit. Recovery is test-only,
  // opt-in, bounded, and never triggered by a timeout or unsigned response.
  async deliverPending(scope: EditorialScope, task: string, target: string,
    config: EditorialDeliveryConfig,
    fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch) {
    const peer = editorialWireConfig(config);
    if (scope.org_id !== peer.orgId || scope.is_test !== true) {
      throw new EditorialTransportError();
    }
    const raw = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (raw === null) return { status: 'no_pending' as const, operation: 'none' as const };
    const pending = editorialPending(raw, peer.orgId, task);

    // Prisma's standalone query commits the SQL reservation before HTTP.
    // Uncertain DB errors cannot trigger the signed send.
    const reserved = await this.posts.reserveEditorialSubmit(
      scope, task, target, pending.event_id,
    );
    if (reserved === null) return { status: 'no_pending' as const, operation: 'none' as const };
    if (!reserved || typeof reserved !== 'object' || Array.isArray(reserved) ||
        reserved.event_id !== pending.event_id ||
        typeof reserved.newly_reserved !== 'boolean') {
      throw new EditorialTransportError();
    }
    let operation: 'submit' | 'lookup' = reserved.newly_reserved ? 'submit' : 'lookup';

    // Re-read after reservation: a changed/confirmed event cannot borrow it.
    const current = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (current === null) return { status: 'no_pending' as const, operation };
    const fresh = editorialPending(current, peer.orgId, task);
    if (fresh.event_id !== pending.event_id ||
        fresh.payload_sha256 !== pending.payload_sha256) {
      throw new EditorialTransportError();
    }

    let remote = await signedEditorialRequest(fresh, config, operation, fetcher);
    if (operation === 'lookup' && remote.found === false && remote.outcome === null) {
      if (config.allowMissingRecovery !== true || target !== 'max:-73052031470103') {
        return { status: 'unknown' as const, operation };
      }
      // The SQL claim is committed before HTTP. A refused/exhausted/ambiguous
      // claim cannot send. Existing primary and recovery rows are immutable.
      const claimed = await this.posts.reserveEditorialRecovery(
        scope, task, target, fresh.event_id, fresh.payload_sha256,
      );
      if (claimed !== true) return { status: 'unknown' as const, operation };
      const afterClaim = await this.posts.readPendingEditorialDelivery(scope, task, target);
      if (afterClaim === null) return { status: 'no_pending' as const, operation };
      const same = editorialPending(afterClaim, peer.orgId, task);
      if (same.event_id !== fresh.event_id || same.payload_sha256 !== fresh.payload_sha256) {
        throw new EditorialTransportError();
      }
      // Same event, not a new human decision. The remote SQL reducer
      // serializes the task and replays an existing exact-event receipt.
      operation = 'submit';
      remote = await signedEditorialRequest(same, config, operation, fetcher);
    }
    if (remote.outcome === null) throw new EditorialTransportError();
    const recorded = await this.posts.importEditorialDecisionResult(
      scope, task, target, fresh.event_id, fresh.payload_sha256,
      remote.outcome as Parameters<PostsRepository['importEditorialDecisionResult']>[5],
    );
    return { status: 'recorded' as const, operation, receipt: recorded };
  }
}
