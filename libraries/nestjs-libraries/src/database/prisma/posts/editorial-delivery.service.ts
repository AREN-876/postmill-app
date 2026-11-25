import { Inject, Injectable } from '@nestjs/common';
import { PostsRepository } from './posts.repository';
import { validateEditorialArtifact, type EditorialScope } from './editorial-ingress';
import {
  editorialPending, editorialWireConfig, editorialLoopbackFetch, EditorialTransportError,
  signedEditorialRequest, signedEditorialRevisionLookup, signedEditorialLiveReviewRequest,
  type EditorialWireConfig, type EditorialLiveReviewPin, type EditorialPending,
} from './editorial-signed-transport';

// Used by the isolated, default-off editorial Inngest activity. It reserves
// primary submit durably; recovery additionally requires signed absence and a separate reservation.
// Human commands must first pass cookie/CSRF/RBAC and be persisted in Postmill;
// this service cannot grant native publication or paid AI execution.
export type EditorialDeliveryConfig = EditorialWireConfig & {
  allowMissingRecovery?: boolean;
};

function pendingRoute(raw: unknown, config: EditorialWireConfig, task: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EditorialTransportError();
  const {native_pin: pin, ...event}=raw as Record<string,unknown>;
  const pending=editorialPending(event,config.orgId,task);
  if (Object.hasOwn(raw,'native_pin')) {
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (config.allowLiveImageReview!==true || config.orgId!=='org-modes' ||
        !pin || typeof pin!=='object' || Array.isArray(pin) ||
        Object.keys(pin).length!==3) throw new EditorialTransportError();
    const p=pin as Record<string,unknown>;
    if (typeof p.plan_id!=='string' || !uuid.test(p.plan_id) ||
        typeof p.native_file_id!=='string' || !uuid.test(p.native_file_id) ||
        typeof p.asset_sha256!=='string' || !/^[0-9a-f]{64}$/.test(p.asset_sha256) ||
        !pending.event.image || typeof pending.event.image!=='object') throw new EditorialTransportError();
    return {pending,pin:p as EditorialLiveReviewPin};
  }
  return {pending,pin:null};
}
function samePin(a: EditorialLiveReviewPin|null,b: EditorialLiveReviewPin|null) {
  return a===null ? b===null : b!==null && a.plan_id===b.plan_id &&
    a.native_file_id===b.native_file_id && a.asset_sha256===b.asset_sha256;
}
function send(pending: EditorialPending,pin: EditorialLiveReviewPin|null,config: EditorialWireConfig,
  operation:'submit'|'lookup',fetcher:typeof editorialLoopbackFetch) {
  return pin ? signedEditorialLiveReviewRequest(pending,pin,config,operation,fetcher) :
    signedEditorialRequest(pending,config,operation,fetcher);
}

@Injectable()
export class EditorialDeliveryService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository) {}

  // The caller is the scoped test-only sweep, never a human HTTP endpoint.
  // Proof lookup cannot write remotely. The native artifact is independently
  // validated before the local SQL transaction consumes it.
  async reconcileTextRevision(scope: EditorialScope, task: string, target: string,
    eventId: string, digest: string, config: EditorialWireConfig,
    fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch) {
    const peer = editorialWireConfig(config);
    if (scope.org_id !== peer.orgId || scope.is_test !== true ||
        (scope.image_mode !== 'disabled' && !(config.allowMockImageReview === true && scope.org_id === 'org-modes' &&
          scope.integration_id.startsWith('mock-review-') && ['automatic','manual','after_text_approval'].includes(scope.image_mode))) || target !== 'max:-73052031470103') {
      throw new EditorialTransportError();
    }
    const proof = await signedEditorialRevisionLookup({
      org_id: scope.org_id, task_id: task, event_id: eventId, payload_sha256: digest,
    }, config, fetcher);
    if (proof === null) return { status: 'not_ready' as const };
    if (proof.state.image_mode !== scope.image_mode) throw new EditorialTransportError();
    const ref = proof.state.text;
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
        typeof (ref as Record<string, unknown>).revision !== 'number' ||
        !Number.isSafeInteger((ref as Record<string, unknown>).revision) ||
        Number((ref as Record<string, unknown>).revision) < 2) {
      throw new EditorialTransportError();
    }
    try {
      validateEditorialArtifact(proof.install_event.revision_content,
        (ref as Record<string, unknown>).sha256);
    } catch {
      throw new EditorialTransportError();
    }
    const receipt = await this.posts.importEditorialTextRevision(
      scope, task, target, eventId, digest, proof,
    );
    return { status: 'recorded' as const, receipt };
  }

  // Read-only lookup may run without a send reservation; primary submit may not.
  async reconcileOnce(scope: EditorialScope, task: string, target: string,
    config: EditorialWireConfig, fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch) {
    const peer = editorialWireConfig(config);
    if (scope.org_id !== peer.orgId || scope.is_test !== true) {
      throw new EditorialTransportError();
    }
    const raw = await this.posts.readPendingEditorialDelivery(scope, task, target);
    if (raw === null) return { status: 'no_pending' as const };
    const {pending,pin}=pendingRoute(raw,config,task);
    const remote=await send(pending,pin,config,'lookup',fetcher);
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
    const {pending,pin}=pendingRoute(raw,config,task);

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
    const {pending:fresh,pin:freshPin}=pendingRoute(current,config,task);
    if (fresh.event_id !== pending.event_id ||
        fresh.payload_sha256 !== pending.payload_sha256 || !samePin(pin,freshPin)) {
      throw new EditorialTransportError();
    }

    let remote=await send(fresh,freshPin,config,operation,fetcher);
    if (operation === 'lookup' && remote.found === false && remote.outcome === null) {
      if (pin || config.allowMissingRecovery !== true || target !== 'max:-73052031470103') {
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
      const {pending:same,pin:afterPin}=pendingRoute(afterClaim,config,task);
      if (same.event_id !== fresh.event_id || same.payload_sha256 !== fresh.payload_sha256 || afterPin !== null) {
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
