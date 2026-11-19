import { createHash, timingSafeEqual } from 'node:crypto';
import {
  maxStoryParts,
  STORYGO_DIVIDER,
} from '@postmill-ai/provider-kernel/domains/max-story';

// Offline admission boundary only. No HTTP registration, DB write or dispatch.
// The caller must load scope from trusted server-side configuration, never from
// request JSON. The eventual transport must independently verify active target
// ownership, eligibility and the test-channel mapping before atomic persistence.
export class EditorialIngressError extends Error {
  constructor(public readonly code: 'unauthorized' | 'invalid_request' | 'scope_mismatch' | 'digest_mismatch') {
    super(code);
    this.name = 'EditorialIngressError';
  }
}

const MODES = ['after_text_approval', 'automatic', 'manual', 'disabled'] as const;
type ImageMode = (typeof MODES)[number];
export type EditorialScope = {
  org_id: string;
  integration_id: string;
  campaign_id: string;
  channel_id: string;
  profile_ref: string;
  is_test: true;
  image_mode: ImageMode;
};
type Content = { title: string; parts: [string, string, string] };

export type PreparedEditorialDraft = {
  schema_version: 1;
  task_id: string;
  scope: EditorialScope;
  text: { revision: 1; sha256: string };
  content: Content;
  firstPart: string;
  continuationText: string;
};

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
const SCOPE_KEYS = [
  'org_id', 'integration_id', 'campaign_id', 'channel_id', 'profile_ref', 'is_test', 'image_mode',
] as const;
const SHA = /^[0-9a-f]{64}$(?![\s\S])/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$(?![\s\S])/;
const PROFILE = /^[a-z][a-z0-9_-]{0,63}@v[1-9][0-9]{0,8}$(?![\s\S])/;

export function isEditorialTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$(?![\s\S])/.test(value) &&
    (value.length < 19 || value <= '9223372036854775807');
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function scopeOf(value: Record<string, unknown>): EditorialScope | undefined {
  if (!identifier(value.org_id) || !identifier(value.integration_id) ||
      value.integration_id.startsWith('fixture:') || !identifier(value.campaign_id) ||
      !isEditorialTaskId(value.channel_id) || typeof value.profile_ref !== 'string' ||
      !PROFILE.test(value.profile_ref) || value.is_test !== true ||
      !MODES.includes(value.image_mode as ImageMode)) return undefined;
  return {
    org_id: value.org_id, integration_id: value.integration_id,
    campaign_id: value.campaign_id, channel_id: value.channel_id,
    profile_ref: value.profile_ref, is_test: true, image_mode: value.image_mode as ImageMode,
  };
}

// A dedicated 256-bit random machine secret. Only its SHA-256 digest is
// configured here. No cookie, OAuth, generic pm_live key, or implicit scope.
export function authenticateEditorialMachine(authorization: unknown, configured: unknown, now = Date.now()): EditorialScope {
  if (!exact(configured, [...SCOPE_KEYS, 'token_sha256', 'expires_at']) ||
      typeof configured.token_sha256 !== 'string' || !SHA.test(configured.token_sha256) ||
      typeof configured.expires_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$(?![\s\S])/.test(configured.expires_at) ||
      !Number.isFinite(now) || typeof authorization !== 'string' ||
      !/^Bearer edx_v1_[0-9a-f]{64}$(?![\s\S])/.test(authorization)) {
    throw new EditorialIngressError('unauthorized');
  }
  const expiry = Date.parse(configured.expires_at);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== configured.expires_at || expiry <= now) {
    throw new EditorialIngressError('unauthorized');
  }
  const scope = scopeOf(configured);
  const actual = createHash('sha256').update(authorization.slice(7), 'utf8').digest();
  const expected = Buffer.from(configured.token_sha256, 'hex');
  if (!timingSafeEqual(actual, expected) || !scope) {
    throw new EditorialIngressError('unauthorized');
  }
  return scope;
}

// The Editorial-013 text artifact is EXACTLY {title, parts}. PostgreSQL jsonb
// orders these two equal-byte-length keys by byte value (parts, then title).
// Only strings in a three-element array occur, so no generic JS JSONB
// serialization (number precision, arbitrary keys, duplicate keys) is assumed.
// PG17 fixture independently checks this encoding with Cyrillic/emoji/escapes.
function editorialTextDigest(content: Content): string {
  const pgText = '{"parts": [' + content.parts.map((part) => JSON.stringify(part)).join(', ') +
    '], "title": ' + JSON.stringify(content.title) + '}';
  return createHash('sha256').update(pgText, 'utf8').digest('hex');
}

function contentOf(value: unknown): Content {
  if (!exact(value, ['title', 'parts']) || typeof value.title !== 'string' ||
      !value.title || value.title !== value.title.trim() || value.title.length > 160 ||
      /[\n\r\t]/u.test(value.title) || !Array.isArray(value.parts) || value.parts.length !== 3 ||
      !Array.from(value.parts).every((p) => typeof p === 'string' && p.length <= 4000 && p.trim())) {
    throw new EditorialIngressError('invalid_request');
  }
  const parts = Array.from(value.parts) as Content['parts'];
  const content = { title: value.title, parts };
  // Conservative test-only v1: no possible markup/entity reinterpretation
  // until native composer/render round-trip is qualified. No silent sanitizing
  // or trimming of already hashed text. The native shared validator additionally
  // rejects CRLF, controls, lone surrogates, divider lines and UTF-16 overflow.
  if ([content.title, ...parts].some((s) =>
    s.includes(STORYGO_DIVIDER) || /[<>]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/iu.test(s))) {
    throw new EditorialIngressError('invalid_request');
  }
  return content;
}

export function prepareEditorialDraft(
  authorization: unknown,
  configuredScope: unknown,
  body: unknown,
  now = Date.now(),
): PreparedEditorialDraft {
  const scope = authenticateEditorialMachine(authorization, configuredScope, now);
  if (!exact(body, ['schema_version', 'task_id', ...SCOPE_KEYS, 'text', 'content']) ||
      body.schema_version !== 1 || !isEditorialTaskId(body.task_id)) {
    throw new EditorialIngressError('invalid_request');
  }
  const claimed = scopeOf(body);
  if (!claimed || SCOPE_KEYS.some((key) => claimed[key] !== scope[key])) {
    throw new EditorialIngressError('scope_mismatch');
  }
  if (!exact(body.text, ['revision', 'sha256']) || body.text.revision !== 1 ||
      typeof body.text.sha256 !== 'string' || !SHA.test(body.text.sha256)) {
    throw new EditorialIngressError('invalid_request');
  }
  const content = contentOf(body.content);
  const firstPart = content.title + '\n\n' + content.parts[0];
  const continuationText = content.parts.slice(1).join('\n' + STORYGO_DIVIDER + '\n');
  try {
    const checked = maxStoryParts(firstPart, continuationText);
    if (checked.title !== content.title || checked.parts.length !== 3 ||
        checked.parts[0] !== firstPart || checked.parts[1] !== content.parts[1] ||
        checked.parts[2] !== content.parts[2]) {
      throw new Error('round trip failed');
    }
  } catch {
    throw new EditorialIngressError('invalid_request');
  }
  if (editorialTextDigest(content) !== body.text.sha256) {
    throw new EditorialIngressError('digest_mismatch');
  }
  return {
    schema_version: 1, task_id: body.task_id, scope,
    text: { revision: 1, sha256: body.text.sha256 },
    content, firstPart, continuationText,
  };
}
