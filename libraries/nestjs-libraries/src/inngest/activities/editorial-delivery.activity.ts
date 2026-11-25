import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { PostsRepository } from '@postmill-ai/nestjs-libraries/database/prisma/posts/posts.repository';
import { EditorialDeliveryService } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-delivery.service';
import { editorialWireConfig } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-signed-transport';

const TEST_TARGET = 'max:-73052031470103';
const REQUEST_SECRET_FILE = '/run/secrets/postmill_editorial_request_hmac_hex';
const RESPONSE_SECRET_FILE = '/run/secrets/postmill_editorial_response_hmac_hex';
const ORG = /^[A-Za-z0-9_.:-]{1,200}$/;
const HEX = /^[0-9a-f]{64}$/;

// The same exact, secret-free gate controls Inngest registration at boot
// and protects each run if environment configuration is later removed.
// Missing HMAC files still fail closed in runtime(), never at registration.
export function editorialTestDeliveryScope(
  e: Readonly<Record<string, string | undefined>>,
): { orgId: string; target: typeof TEST_TARGET } | null {
  const orgId = e.EDITORIAL_TEST_ORG_ID;
  if (e.EDITORIAL_TEST_DELIVERY_ENABLED !== 'true' ||
      e.EDITORIAL_TEST_SESSION_ENABLED !== 'true' ||
      e.EDITORIAL_TEST_MAX_TARGET !== TEST_TARGET ||
      !orgId || !ORG.test(orgId)) {
    return null;
  }
  return { orgId, target: TEST_TARGET };
}

function runtime() {
  const gate = editorialTestDeliveryScope(process.env);
  if (!gate) return null;
  // Keys are mounted read-only as container secrets, never copied into
  // Docker environment, Inngest event payloads or log messages.
  const requestKeyHex = readFileSync(REQUEST_SECRET_FILE, 'utf8').trim();
  const responseKeyHex = readFileSync(RESPONSE_SECRET_FILE, 'utf8').trim();
  if (!HEX.test(requestKeyHex) || !HEX.test(responseKeyHex)) {
    throw new Error('editorial_delivery_keys_invalid');
  }
  const wire = {
    orgId: gate.orgId,
    requestKeyHex, responseKeyHex,
    allowMissingRecovery: process.env.EDITORIAL_TEST_RECOVERY_ENABLED === 'true',
    ...(gate.orgId==='org-modes' && process.env.EDITORIAL_TEST_LIVE_IMAGE_IMPORT_ENABLED==='true' &&
        process.env.EDITORIAL_TEST_LIVE_IMAGE_REVIEW_ENABLED==='true' ? {allowLiveImageReview:true} : {}),
    ...(gate.orgId === 'org-modes' && process.env.EDITORIAL_TEST_MOCK_IMAGE_IMPORT_ENABLED === 'true'
      ? {allowMockImageReview: true} : {}),
  };
  editorialWireConfig(wire);
  return { ...gate, wire, revisionsEnabled: process.env.EDITORIAL_TEST_REVISION_SYNC_ENABLED === 'true' };
}

@Injectable()
export class EditorialDeliveryActivity {
  constructor(
    private readonly posts: PostsRepository,
    private readonly delivery: EditorialDeliveryService,
  ) {}

  // One bounded test-org sweep. No actor is invented: all commands were
  // previously authenticated via cookie+CSRF+RBAC and committed in the outbox.
  // No AI calls or MAX publication can originate from this activity.
  async sweep() {
    const cfg = runtime();
    if (!cfg) return { status: 'disabled' as const };
    const candidates = 'allowLiveImageReview' in cfg.wire && cfg.wire.allowLiveImageReview===true
      ? await this.posts.listPendingEditorialTestDelivery(cfg.orgId,cfg.target,true)
      : await this.posts.listPendingEditorialTestDelivery(cfg.orgId,cfg.target);
    let submitted = 0;
    let lookedUp = 0;
    let confirmed = 0;
    let unknown = 0;
    for (const item of candidates) {
      if (!item.scope || item.scope.org_id !== cfg.orgId ||
          item.scope.is_test !== true || typeof item.task !== 'string') {
        throw new Error('editorial_delivery_scope_mismatch');
      }
      // Service reserves atomically and selects submit versus lookup.
      const result = await this.delivery.deliverPending(
        item.scope, item.task, cfg.target, cfg.wire,
      );
      if (result.operation === 'submit') submitted++;
      if (result.operation === 'lookup') lookedUp++;
      if (result.status === 'recorded') confirmed++;
      if (result.status === 'unknown') unknown++;
    }
    let revisionsRecorded = 0;
    let revisionsWaiting = 0;
    if (cfg.revisionsEnabled) {
      const revisions = cfg.wire.allowMockImageReview
        ? await this.posts.listPendingEditorialTextRevisions(cfg.orgId,cfg.target,true)
        : await this.posts.listPendingEditorialTextRevisions(cfg.orgId,cfg.target);
      for (const item of revisions) {
        if (!item.scope || item.scope.org_id !== cfg.orgId || item.scope.is_test !== true ||
            (item.scope.image_mode !== 'disabled' && !(cfg.wire.allowMockImageReview &&
              item.scope.org_id === 'org-modes' && item.scope.integration_id.startsWith('mock-review-') &&
              ['automatic','manual','after_text_approval'].includes(item.scope.image_mode))) || typeof item.task !== 'string') {
          throw new Error('editorial_revision_scope_mismatch');
        }
        const result = await this.delivery.reconcileTextRevision(
          item.scope, item.task, cfg.target, item.eventId, item.digest, cfg.wire,
        );
        if (result.status === 'recorded') revisionsRecorded++;
        else revisionsWaiting++;
      }
    }
    return {
      status: 'checked' as const,
      revisionsRecorded, revisionsWaiting,
      considered: candidates.length, submitted, lookedUp, confirmed, unknown,
    };
  }
}
