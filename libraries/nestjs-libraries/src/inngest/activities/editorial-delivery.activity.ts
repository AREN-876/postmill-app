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

function runtime() {
  const e = process.env;
  if (e.EDITORIAL_TEST_DELIVERY_ENABLED !== 'true' ||
      e.EDITORIAL_TEST_SESSION_ENABLED !== 'true' ||
      e.EDITORIAL_TEST_MAX_TARGET !== TEST_TARGET ||
      !e.EDITORIAL_TEST_ORG_ID || !ORG.test(e.EDITORIAL_TEST_ORG_ID)) {
    return null;
  }
  // Keys are mounted read-only as container secrets, never copied into
  // Docker environment, Inngest event payloads or log messages.
  const requestKeyHex = readFileSync(REQUEST_SECRET_FILE, 'utf8').trim();
  const responseKeyHex = readFileSync(RESPONSE_SECRET_FILE, 'utf8').trim();
  if (!HEX.test(requestKeyHex) || !HEX.test(responseKeyHex)) {
    throw new Error('editorial_delivery_keys_invalid');
  }
  const wire = {
    orgId: e.EDITORIAL_TEST_ORG_ID,
    requestKeyHex, responseKeyHex,
  };
  editorialWireConfig(wire);
  return { orgId: e.EDITORIAL_TEST_ORG_ID, target: TEST_TARGET, wire };
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
    const candidates = await this.posts.listPendingEditorialTestDelivery(
      cfg.orgId, cfg.target,
    );
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
    return {
      status: 'checked' as const,
      considered: candidates.length, submitted, lookedUp, confirmed, unknown,
    };
  }
}
