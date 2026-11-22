import { Inject, Injectable } from '@nestjs/common';
import { PostsRepository } from './posts.repository';
import { type EditorialScope } from './editorial-ingress';
import {
  editorialPending, editorialWireConfig, editorialLoopbackFetch, EditorialTransportError,
  signedEditorialRequest, type EditorialWireConfig,
} from './editorial-signed-transport';

// Used by the isolated, default-off editorial Inngest activity. Its explicit
// reserved-event entry point never resends an event after an unknown outcome.
// Human commands must first pass cookie/CSRF/RBAC and be persisted in Postmill;
// this service cannot grant native publication or paid AI execution.
@Injectable()
export class EditorialDeliveryService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository) {}

  async attemptOnce(scope: EditorialScope, task: string, target: string,
    config: EditorialWireConfig, fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch) {
    const peer = editorialWireConfig(config);
    if (scope.org_id !== peer.orgId || scope.is_test !== true) {
      throw new EditorialTransportError();
    }
    const raw = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (raw === null) return { status: 'no_pending' as const };
    const pending = editorialPending(raw, scope.org_id, task);
    const remote = await signedEditorialRequest(pending, config, 'submit', fetcher);
    if (remote.outcome === null) throw new EditorialTransportError();
    // The response MAC protects the exact request body and event hash.
    // SQL independently verifies native target, revision/seq and 013 state.
    const recorded = await this.posts.importEditorialDecisionResult(
      scope, task, target, pending.event_id, pending.payload_sha256,
      remote.outcome as Parameters<PostsRepository['importEditorialDecisionResult']>[5],
    );
    return { status: 'recorded' as const, receipt: recorded };
  }

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
  // Used only AFTER a committed send reservation. Both the first submit and
  // subsequent lookup are bound to that exact event ID; a newly queued event
  // can never borrow an earlier event's reservation.
  async deliverReserved(scope: EditorialScope, task: string, target: string,
    config: EditorialWireConfig, reservedEventId: string,
    operation: 'submit' | 'lookup',
    fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch) {
    const peer = editorialWireConfig(config);
    if (scope.org_id !== peer.orgId || scope.is_test !== true) {
      throw new EditorialTransportError();
    }
    const raw = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (raw === null) return { status: 'no_pending' as const };
    const pending = editorialPending(raw, peer.orgId, task);
    if (pending.event_id !== reservedEventId) throw new EditorialTransportError();

    const remote = await signedEditorialRequest(pending, config, operation, fetcher);
    if (operation === 'lookup' && (remote.found !== true || remote.outcome === null)) {
      return { status: 'unknown' as const };
    }
    if (remote.outcome === null) throw new EditorialTransportError();

    const recorded = await this.posts.importEditorialDecisionResult(
      scope, task, target, pending.event_id, pending.payload_sha256,
      remote.outcome as Parameters<PostsRepository['importEditorialDecisionResult']>[5],
    );
    return { status: 'recorded' as const, receipt: recorded };
  }

}
