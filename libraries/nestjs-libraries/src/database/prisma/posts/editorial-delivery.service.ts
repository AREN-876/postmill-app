import { Inject, Injectable } from '@nestjs/common';
import { PostsRepository } from './posts.repository';
import { type EditorialScope } from './editorial-ingress';
import {
  editorialPending, editorialWireConfig, editorialLoopbackFetch, EditorialTransportError,
  signedEditorialRequest, type EditorialWireConfig,
} from './editorial-signed-transport';

// Used by the isolated, default-off editorial Inngest activity. It reserves
// an event durably before primary submit and only looks up any reserved event.
// Human commands must first pass cookie/CSRF/RBAC and be persisted in Postmill;
// this service cannot grant native publication or paid AI execution.
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
  // The committed SQL reservation exclusively determines primary submit or
  // read-only lookup. There is no caller-selected submit/retry operation.
  async deliverPending(scope: EditorialScope, task: string, target: string,
    config: EditorialWireConfig,
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
    const operation = reserved.newly_reserved ? 'submit' as const : 'lookup' as const;

    // Re-read after reservation: a changed/confirmed event cannot borrow it.
    const current = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (current === null) return { status: 'no_pending' as const, operation };
    const fresh = editorialPending(current, peer.orgId, task);
    if (fresh.event_id !== pending.event_id ||
        fresh.payload_sha256 !== pending.payload_sha256) {
      throw new EditorialTransportError();
    }

    const remote = await signedEditorialRequest(fresh, config, operation, fetcher);
    if (operation === 'lookup' && (remote.found !== true || remote.outcome === null)) {
      return { status: 'unknown' as const, operation };
    }
    if (remote.outcome === null) throw new EditorialTransportError();
    const recorded = await this.posts.importEditorialDecisionResult(
      scope, task, target, fresh.event_id, fresh.payload_sha256,
      remote.outcome as Parameters<PostsRepository['importEditorialDecisionResult']>[5],
    );
    return { status: 'recorded' as const, operation, receipt: recorded };
  }
}
