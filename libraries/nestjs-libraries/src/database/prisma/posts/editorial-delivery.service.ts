import { Inject, Injectable } from '@nestjs/common';
import { PostsRepository } from './posts.repository';
import { type EditorialScope } from './editorial-ingress';
import {
  editorialPending, editorialWireConfig, EditorialTransportError,
  signedEditorialRequest, type EditorialWireConfig,
} from './editorial-signed-transport';
import { safeFetch } from '../../../dtos/webhooks/safe.fetch';

// Not registered by any Nest module or Inngest job. No timed polling,
// automatic resend or provider/AI dispatch; activation is a separate gate.
// Caller MUST have independently authenticated the actor/service principal
// and resolved the task, scope, target and peer config from trusted state.
@Injectable()
export class EditorialDeliveryService {
  constructor(@Inject(PostsRepository) private readonly posts: PostsRepository) {}

  async attemptOnce(scope: EditorialScope, task: string, target: string,
    config: EditorialWireConfig, fetcher: typeof safeFetch = safeFetch) {
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
    config: EditorialWireConfig, fetcher: typeof safeFetch = safeFetch) {
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
}
