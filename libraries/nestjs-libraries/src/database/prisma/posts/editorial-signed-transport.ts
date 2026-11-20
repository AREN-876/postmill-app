import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';

export const EDITORIAL_SUBMIT_PATH = '/internal/editorial/v1/events/submit';
export const EDITORIAL_LOOKUP_PATH = '/internal/editorial/v1/events/lookup';
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
function sha(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
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
 * Only these two literal loopback URLs can reach undici. No redirects.
 * No callers outside this signed Editorial path should use this adapter.
 */
export async function editorialLoopbackFetch(url: string, init?: RequestInit): Promise<Response> {
  if ((url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_SUBMIT_PATH &&
       url !== EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_LOOKUP_PATH) ||
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
  requestRaw: string, responseRaw: string): string {
  return ['EDX1', 'RESP', path, timestamp, nonce, sha(requestRaw), sha(responseRaw)].join('\n');
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
        response.headers.get('content-type') !== 'application/json' ||
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
        if (total > MAX_BODY) throw new EditorialTransportError();
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const responseRaw = Buffer.concat(chunks).toString('utf8');
    if (!Buffer.from(responseRaw, 'utf8').equals(Buffer.concat(chunks))) {
      throw new EditorialTransportError();
    }
    const supplied = response.headers.get('x-edx-response-signature');
    if (!supplied || !/^sha256=[a-f0-9]{64}$/.test(supplied)) {
      throw new EditorialTransportError();
    }
    const expected = mac(peer.responseKey,
      responseMessage(path, timestamp, nonce, raw, responseRaw));
    if (!timingSafeEqual(Buffer.from(supplied.slice(7), 'hex'), expected)) {
      throw new EditorialTransportError();
    }
    const parsed: unknown = JSON.parse(responseRaw);
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
