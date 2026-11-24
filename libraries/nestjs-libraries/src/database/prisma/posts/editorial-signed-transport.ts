import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

export const EDITORIAL_SUBMIT_PATH = '/internal/editorial/v1/events/submit';
export const EDITORIAL_LOOKUP_PATH = '/internal/editorial/v1/events/lookup';
export const EDITORIAL_REVISION_LOOKUP_PATH = '/internal/editorial/v1/revisions/lookup';
export const EDITORIAL_IMAGE_LOOKUP_PATH = '/internal/editorial/v1/images/lookup';
export const EDITORIAL_IMAGE_READ_PATH = '/internal/editorial/v1/images/read';
const MAX_IMAGE_RESPONSE = 8 * 1024 * 1024;
const MAX_REVISION_RESPONSE = 100_000;
// Fixed numeric loopback only. No DNS, configurable URL, public origin or TLS
// proxy. Receiver MUST share the Postmill container's network namespace;
// 127.0.0.1 otherwise fails closed (never point this at a host/public port).
export const EDITORIAL_LOOPBACK_ORIGIN = 'http://127.0.0.1:8794';
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORG = /^[A-Za-z0-9_.:-]{1,200}$/;
const TASK = /^[1-9][0-9]{0,18}$/;
const MAX_BODY = 32_768;

type JsonRecord = Record<string, unknown>;
type ReplyOutcome = {
  status: 'accepted' | 'rejected';
  reason: string | null;
  state: JsonRecord;
  dispatch_authorized: false;
  publishable: false;
  newly_applied: boolean;
  replay: boolean;
};

export type EditorialWireConfig = {
  requestKeyHex: string;
  responseKeyHex: string;
  orgId: string;
};
export type EditorialPending = {
  schema_version: 1;
  org_id: string;
  task_id: string;
  event_id: string;
  payload_sha256: string;
  event: JsonRecord;
  dispatch_authorized: false;
  publishable: false;
};
export type EditorialWireResponse = {
  schema_version: 1;
  event_id: string;
  payload_sha256: string;
  outcome: ReplyOutcome | null;
  found?: boolean;
};

// Unknown/ambiguous outcomes never grant a retry or dispatch.
export class EditorialTransportError extends Error {
  constructor() {
    super('editorial_transport_outcome_unknown');
    this.name = 'EditorialTransportError';
  }
}
function record(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
  return record(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
function sha(s: string | Buffer): string {
  return createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');
}
function mac(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'ascii').digest();
}
/** No network destinations are read from config, user input or task JSON. */
export function editorialWireConfig(config: EditorialWireConfig): {
  origin: typeof EDITORIAL_LOOPBACK_ORIGIN;
  requestKey: Buffer; responseKey: Buffer; orgId: string;
} {
  if (!config || !SHA.test(config.requestKeyHex) ||
      !SHA.test(config.responseKeyHex) || config.requestKeyHex === config.responseKeyHex ||
      !ORG.test(config.orgId) || Object.hasOwn(config, 'origin')) {
    throw new EditorialTransportError();
  }
  return {
    origin: EDITORIAL_LOOPBACK_ORIGIN, orgId: config.orgId,
    requestKey: Buffer.from(config.requestKeyHex, 'hex'),
    responseKey: Buffer.from(config.responseKeyHex, 'hex'),
  };
}

/** Dedicated internal transport. Never relax shared safeFetch SSRF policy.
 * Only the literal Editorial loopback URLs can reach undici. No redirects.
 * No callers outside this signed Editorial path should use this adapter.
 */
export async function editorialLoopbackFetch(url: string, init?: RequestInit): Promise<Response> {
  if ((url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_SUBMIT_PATH &&
       url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_LOOKUP_PATH &&
       url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_REVISION_LOOKUP_PATH &&
       url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_IMAGE_LOOKUP_PATH &&
       url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_IMAGE_READ_PATH) ||
      init?.method !== 'POST' || init.redirect !== 'error') {
    throw new EditorialTransportError();
  }
  return await undiciFetch(url, init as UndiciRequestInit) as unknown as Response;
}

export function editorialPending(row: unknown, orgId: string, taskId: string): EditorialPending {
  if (!exact(row, ['schema_version', 'org_id', 'task_id', 'event_id',
    'payload_sha256', 'event', 'dispatch_authorized', 'publishable']) ||
      row.schema_version !== 1 || row.org_id !== orgId || row.task_id !== taskId ||
      typeof row.event_id !== 'string' || !UUID.test(row.event_id) ||
      typeof row.payload_sha256 !== 'string' || !SHA.test(row.payload_sha256) ||
      row.dispatch_authorized !== false || row.publishable !== false ||
      !record(row.event) || row.event.event_id !== row.event_id ||
      row.event.producer !== 'postmill' || !record(row.event.binding) ||
      row.event.binding.org_id !== orgId || row.event.binding.task_id !== taskId ||
      row.event.binding.is_test !== true || row.event.schema_version !== 1 ||
      !TASK.test(taskId) ||
      (taskId.length === 19 && taskId > '9223372036854775807')) {
    throw new EditorialTransportError();
  }
  return row as EditorialPending;
}
function checkedOutcome(value: unknown): ReplyOutcome {
  if (!exact(value, ['status', 'reason', 'state',
    'dispatch_authorized', 'publishable', 'newly_applied', 'replay']) ||
      !['accepted', 'rejected'].includes(value.status as string) ||
      !(value.reason === null || typeof value.reason === 'string') ||
      !record(value.state) || value.dispatch_authorized !== false || value.publishable !== false ||
      typeof value.newly_applied !== 'boolean' || typeof value.replay !== 'boolean') {
    throw new EditorialTransportError();
  }
  return value as ReplyOutcome;
}
function requestMessage(path: string, timestamp: string, nonce: string, raw: string): string {
  return ['EDX1', 'REQ', path, timestamp, nonce, sha(raw)].join('\n');
}
function responseMessage(path: string, timestamp: string, nonce: string,
  requestRaw: string, responseRaw: string | Buffer): string {
  return ['EDX1', 'RESP', path, timestamp, nonce, sha(requestRaw), sha(responseRaw)].join('\n');
}

// Shared bounded signed round-trip; request and response limits remain separate.
type EditorialPath = typeof EDITORIAL_SUBMIT_PATH | typeof EDITORIAL_LOOKUP_PATH |
  typeof EDITORIAL_REVISION_LOOKUP_PATH | typeof EDITORIAL_IMAGE_LOOKUP_PATH | typeof EDITORIAL_IMAGE_READ_PATH;

async function signedExchangeRaw(
  path: EditorialPath, body: JsonRecord, config: EditorialWireConfig,
  fetcher: typeof editorialLoopbackFetch, nowMs: number, nonce: string,
  responseLimit: number, contentType: 'application/json' | 'application/octet-stream',
): Promise<Buffer> {
  const peer = editorialWireConfig(config);
  if (!Number.isSafeInteger(nowMs) || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw new EditorialTransportError();
  }
  const raw = JSON.stringify(body);
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) throw new EditorialTransportError();
  const timestamp = String(Math.floor(nowMs / 1000));
  if (!/^[1-9][0-9]{9}$/.test(timestamp)) throw new EditorialTransportError();
  const url = peer.origin + path;
  const signature = 'sha256=' + mac(peer.requestKey,
    requestMessage(path, timestamp, nonce, raw)).toString('hex');
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: {
        'content-type': 'application/json',
        'x-edx-timestamp': timestamp,
        'x-edx-nonce': nonce,
        'x-edx-signature': signature,
      },
      body: raw,
    });
    if (response.status !== 200 || (response.url && response.url !== url) ||
        response.headers.get('content-type') !== contentType ||
        !response.headers.get('cache-control')?.includes('no-store')) {
      throw new EditorialTransportError();
    }
    // A pinned peer still must not be able to exhaust memory with an
    // arbitrary-length response. Read bounded chunks, never whole-body text().
    const chunks: Buffer[] = [];
    let total = 0;
    if (!response.body) throw new EditorialTransportError();
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > responseLimit) {
          await reader.cancel().catch(() => undefined);
          throw new EditorialTransportError();
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const responseRaw = Buffer.concat(chunks, total);
    const supplied = response.headers.get('x-edx-response-signature');
    if (!supplied || !/^sha256=[a-f0-9]{64}$/.test(supplied)) {
      throw new EditorialTransportError();
    }
    const expected = mac(peer.responseKey,
      responseMessage(path, timestamp, nonce, raw, responseRaw));
    if (!timingSafeEqual(Buffer.from(supplied.slice(7), 'hex'), expected)) {
      throw new EditorialTransportError();
    }
    return responseRaw;
  } catch {
    throw new EditorialTransportError();
  }
}

async function signedExchangeBody(
  path: EditorialPath, body: JsonRecord, config: EditorialWireConfig,
  fetcher: typeof editorialLoopbackFetch, nowMs: number, nonce: string, responseLimit: number,
): Promise<unknown> {
  const bytes = await signedExchangeRaw(path, body, config, fetcher, nowMs, nonce,
    responseLimit, 'application/json');
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(bytes)) throw new EditorialTransportError();
  try { return JSON.parse(raw) as unknown; } catch { throw new EditorialTransportError(); }
}

export async function signedEditorialRequest(
  pending: EditorialPending, config: EditorialWireConfig,
  operation: 'submit' | 'lookup',
  fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch,
  nowMs: number = Date.now(),
  nonce: string = randomBytes(16).toString('hex'),
): Promise<EditorialWireResponse> {
  const peer = editorialWireConfig(config);
  editorialPending(pending, peer.orgId, pending.task_id);
  if (!Number.isSafeInteger(nowMs) || !/^[0-9a-f]{32}$/.test(nonce)) {
    throw new EditorialTransportError();
  }
  const path = operation === 'submit' ? EDITORIAL_SUBMIT_PATH : EDITORIAL_LOOKUP_PATH;
  const body: JsonRecord = {
    schema_version: 1, org_id: pending.org_id, task_id: pending.task_id,
    event_id: pending.event_id, payload_sha256: pending.payload_sha256,
  };
  if (operation === 'submit') body.event = pending.event;
  try {
    const parsed = await signedExchangeBody(path, body, config, fetcher, nowMs, nonce, MAX_BODY);
    const keys = operation === 'submit'
      ? ['schema_version', 'event_id', 'payload_sha256', 'outcome']
      : ['schema_version', 'event_id', 'payload_sha256', 'found', 'outcome'];
    if (!exact(parsed, keys) || parsed.schema_version !== 1 ||
        parsed.event_id !== pending.event_id ||
        parsed.payload_sha256 !== pending.payload_sha256) {
      throw new EditorialTransportError();
    }
    if (operation === 'lookup' && typeof parsed.found !== 'boolean') {
      throw new EditorialTransportError();
    }
    if (operation === 'lookup' && parsed.found === false) {
      if (parsed.outcome !== null) throw new EditorialTransportError();
      return parsed as EditorialWireResponse;
    }
    checkedOutcome(parsed.outcome);
    return parsed as EditorialWireResponse;
  } catch {
    // Transport expiry, timeout, bad/unsigned response or DB error:
    // UNKNOWN, never implicit retry, never "rejected", never approval.
    throw new EditorialTransportError();
  }
}


export type EditorialRevisionRequest = {
  org_id: string; task_id: string; event_id: string; payload_sha256: string;
};
export type EditorialRevisionProof = {
  install_event_id: string; install_payload_sha256: string;
  install_event: JsonRecord; state: JsonRecord;
  publishable: false; dispatch_authorized: false;
};

// Only a signed read of the original accepted return request, never a
// sender-side install command. SQL independently re-derives the transition.
export async function signedEditorialRevisionLookup(
  request: EditorialRevisionRequest, config: EditorialWireConfig,
  fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch,
  nowMs = Date.now(), nonce = randomBytes(16).toString('hex'),
): Promise<EditorialRevisionProof | null> {
  const peer = editorialWireConfig(config);
  if (!exact(request, ['org_id','task_id','event_id','payload_sha256']) ||
      request.org_id !== peer.orgId || typeof request.task_id !== 'string' ||
      !TASK.test(request.task_id) ||
      (request.task_id.length === 19 && request.task_id > '9223372036854775807') ||
      typeof request.event_id !== 'string' || !UUID.test(request.event_id) ||
      typeof request.payload_sha256 !== 'string' || !SHA.test(request.payload_sha256)) {
    throw new EditorialTransportError();
  }
  const body = { schema_version: 1, org_id: request.org_id, task_id: request.task_id,
    event_id: request.event_id, payload_sha256: request.payload_sha256 };
  const parsed = await signedExchangeBody(EDITORIAL_REVISION_LOOKUP_PATH, body, config,
    fetcher, nowMs, nonce, MAX_REVISION_RESPONSE);
  if (!exact(parsed, ['schema_version','event_id','payload_sha256','found','proof']) ||
      parsed.schema_version !== 1 || parsed.event_id !== request.event_id ||
      parsed.payload_sha256 !== request.payload_sha256 || typeof parsed.found !== 'boolean') {
    throw new EditorialTransportError();
  }
  if (parsed.found === false) {
    if (parsed.proof !== null) throw new EditorialTransportError();
    return null;
  }
  const p = parsed.proof;
  if (!exact(p, ['install_event_id','install_payload_sha256','install_event','state','publishable','dispatch_authorized']) ||
      typeof p.install_event_id !== 'string' || !p.install_event_id.trim() || p.install_event_id.length > 200 ||
      typeof p.install_payload_sha256 !== 'string' || !SHA.test(p.install_payload_sha256) ||
      !record(p.install_event) || !record(p.state) ||
      p.publishable !== false || p.dispatch_authorized !== false ||
      p.install_event.event_id !== p.install_event_id || p.install_event.producer !== 'operator' ||
      p.install_event.action !== 'install_text' || p.install_event.request_id !== request.event_id ||
      !record(p.install_event.binding) || p.install_event.binding.org_id !== request.org_id ||
      p.install_event.binding.task_id !== request.task_id || p.install_event.binding.is_test !== true ||
      p.state.publishable !== false || p.state.dispatch_authorized !== false ||
      p.state.image_mode !== 'disabled' || p.state.text_status !== 'pending' ||
      p.state.final_approved !== false || p.state.rejected !== false) {
    throw new EditorialTransportError();
  }
  return p as EditorialRevisionProof;
}


// Mock-only image protocol. No registered runtime caller, native media write,
// paid dispatch, publication, or generic JSONB serializer. Only the exact
// fixture artifact can be fetched by this initial receiver.
const MOCK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg==', 'base64');
const STATE_KEYS = ['binding','seq','image_mode','text_status','text_request_id','text','image',
  'image_compatible','image_intent','rejected','final_approved','dispatch_authorized','publishable'];
const BINDING_KEYS = ['task_id','profile_ref','org_id','integration_id','post_id','group_id','is_test'];
const EVENT_KEYS = ['schema_version','event_id','producer','actor_id','occurred_at','binding',
  'expected_seq','action','text','image','feedback','request_id','revision_content'];

export type EditorialMockImageRequest = {
  org_id: string; task_id: string; channel_id: string; state: JsonRecord;
};
export type EditorialMockImageAsset = {
  asset_id: string; sha256: string; mime: 'image/png'; width: 2; height: 2;
  size_bytes: number; provider: 'mock'; model: 'solid-rgb-v1'; job_id: string;
};
export type EditorialMockImageProof = {
  channel_id: string; install_event_id: string; install_payload_sha256: string;
  install_event: JsonRecord; state: JsonRecord; manifest: [EditorialMockImageAsset];
  publishable: false; dispatch_authorized: false;
};

function validInt64(value: unknown, allowZero = false): value is string {
  return typeof value === 'string' && (TASK.test(value) || (allowZero && value === '0')) &&
    (value.length < 19 || value <= '9223372036854775807');
}
function validString(value: unknown, max = 200): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max &&
    !value.includes('\u0000') && Buffer.from(value, 'utf8').toString('utf8') === value;
}
function artifactRef(value: unknown): value is { revision: number; sha256: string } {
  return exact(value, ['revision','sha256']) && typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) && value.revision > 0 && value.revision <= 2147483647 &&
    typeof value.sha256 === 'string' && SHA.test(value.sha256);
}
// Restricted, bounded serialization for the known proof/event/manifest shape:
// ASCII object keys, safe integers, no floating point, no custom objects.
// PG jsonb sorts keys by UTF-8 byte length then byte order, not insertion order.
function mockProofJson(value: unknown, depth = 0): string {
  if (depth > 8) throw new EditorialTransportError();
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string' && !value.includes('\u0000') &&
      Buffer.from(value, 'utf8').toString('utf8') === value) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(v => mockProofJson(v, depth+1)).join(', ') + ']';
  if (record(value)) {
    const keys = Object.keys(value);
    if (keys.some(k => !/^[a-z][a-z0-9_]*$/.test(k))) throw new EditorialTransportError();
    keys.sort((a,b) => a.length-b.length || (a < b ? -1 : a > b ? 1 : 0));
    return '{' + keys.map(k => JSON.stringify(k)+': '+mockProofJson(value[k], depth+1)).join(', ') + '}';
  }
  throw new EditorialTransportError();
}
function sameMockProof(a: unknown, b: unknown): boolean {
  return mockProofJson(a) === mockProofJson(b);
}
function checkedMockRequest(request: EditorialMockImageRequest, config: EditorialWireConfig): void {
  const peer = editorialWireConfig(config);
  if (!exact(request, ['org_id','task_id','channel_id','state']) ||
      request.org_id !== peer.orgId || request.org_id !== 'org-modes' ||
      !validInt64(request.task_id) || !validInt64(request.channel_id) ||
      !exact(request.state, STATE_KEYS) || Buffer.byteLength(mockProofJson(request.state)) > 8192) {
    throw new EditorialTransportError();
  }
  const s = request.state;
  if (!exact(s.binding, BINDING_KEYS) || s.binding.org_id !== request.org_id ||
      s.binding.task_id !== request.task_id || s.binding.is_test !== true ||
      !validString(s.binding.integration_id) || !s.binding.integration_id.startsWith('mock-review-') ||
      !validString(s.binding.post_id) || !validString(s.binding.group_id) ||
      !validString(s.binding.profile_ref) || !validInt64(s.seq, true) ||
      !['after_text_approval','automatic','manual'].includes(s.image_mode as string) ||
      !['pending','approved'].includes(s.text_status as string) ||
      (s.image_mode === 'after_text_approval' && s.text_status !== 'approved') ||
      s.text_request_id !== null || !artifactRef(s.text) ||
      !(s.image === null || artifactRef(s.image)) ||
      !validString(s.image_intent, 220) || s.image_compatible !== false || s.rejected !== false ||
      s.final_approved !== false || s.publishable !== false || s.dispatch_authorized !== false) {
    throw new EditorialTransportError();
  }
}
function checkedMockProof(request: EditorialMockImageRequest, value: unknown): EditorialMockImageProof {
  if (!exact(value, ['channel_id','install_event_id','install_payload_sha256','install_event','state',
      'manifest','publishable','dispatch_authorized']) ||
      value.channel_id !== request.channel_id || value.publishable !== false ||
      value.dispatch_authorized !== false || !validString(value.install_event_id) ||
      typeof value.install_payload_sha256 !== 'string' || !SHA.test(value.install_payload_sha256) ||
      !exact(value.install_event, EVENT_KEYS) || !exact(value.state, STATE_KEYS) ||
      !Array.isArray(value.manifest) || value.manifest.length !== 1) throw new EditorialTransportError();
  const before = request.state, after = value.state, event = value.install_event, asset = value.manifest[0];
  if (!exact(asset, ['asset_id','sha256','mime','width','height','size_bytes','provider','model','job_id']) ||
      typeof asset.asset_id !== 'string' || !UUID.test(asset.asset_id) ||
      typeof asset.job_id !== 'string' || !UUID.test(asset.job_id) ||
      asset.sha256 !== sha(MOCK_PNG) || asset.size_bytes !== MOCK_PNG.length ||
      asset.mime !== 'image/png' || asset.width !== 2 || asset.height !== 2 ||
      asset.provider !== 'mock' || asset.model !== 'solid-rgb-v1' ||
      !artifactRef(after.image) || after.image.sha256 !== sha(mockProofJson(value.manifest)) ||
      after.image.revision !== (artifactRef(before.image) ? before.image.revision : 0)+1 ||
      !sameMockProof(after, {...before, seq: (BigInt(before.seq as string)+1n).toString(),
        image: after.image, image_compatible: true, image_intent: null, final_approved: false}) ||
      event.schema_version !== 1 || event.event_id !== value.install_event_id ||
      event.producer !== 'operator' || event.action !== 'install_image' ||
      !validString(event.actor_id) || typeof event.occurred_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(event.occurred_at) ||
      event.expected_seq !== before.seq || !sameMockProof(event.binding,before.binding) ||
      !sameMockProof(event.text,before.text) || !sameMockProof(event.image,before.image) ||
      event.feedback !== '' || event.request_id !== before.image_intent ||
      !sameMockProof(event.revision_content,{job_id:asset.job_id,asset_sha256:asset.sha256}) ||
      sha(mockProofJson(event)) !== value.install_payload_sha256) throw new EditorialTransportError();
  return value as EditorialMockImageProof;
}

// Read the signed exact next installation proof and raw bytes. No automatic
// retry, storage side effect or state mutation. Caller supplies a confirmed
// prior state, never a browser-supplied snapshot.
export async function fetchEditorialMockImage(
  request: EditorialMockImageRequest, config: EditorialWireConfig,
  fetcher: typeof editorialLoopbackFetch = editorialLoopbackFetch,
  nowMs = Date.now(),
): Promise<{proof: EditorialMockImageProof; bytes: Buffer} | null> {
  checkedMockRequest(request, config);
  const body = {schema_version:1, ...request};
  const parsed = await signedExchangeBody(EDITORIAL_IMAGE_LOOKUP_PATH, body, config,
    fetcher, nowMs, randomBytes(16).toString('hex'), MAX_BODY);
  if (!exact(parsed,['schema_version','found','proof']) || parsed.schema_version !== 1 ||
      typeof parsed.found !== 'boolean') throw new EditorialTransportError();
  if (!parsed.found) {
    if (parsed.proof !== null) throw new EditorialTransportError();
    return null;
  }
  const proof = checkedMockProof(request, parsed.proof);
  const asset = proof.manifest[0];
  const bytes = await signedExchangeRaw(EDITORIAL_IMAGE_READ_PATH,
    {...body,state:proof.state,asset_id:asset.asset_id,asset_sha256:asset.sha256},
    config, fetcher, nowMs, randomBytes(16).toString('hex'), MAX_IMAGE_RESPONSE,
    'application/octet-stream');
  if (bytes.length !== asset.size_bytes || sha(bytes) !== asset.sha256 ||
      !bytes.equals(MOCK_PNG)) throw new EditorialTransportError();
  return {proof,bytes};
}
