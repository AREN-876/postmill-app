import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  EDITORIAL_LOOKUP_PATH, EDITORIAL_SUBMIT_PATH, EDITORIAL_LOOPBACK_ORIGIN, EDITORIAL_REVISION_LOOKUP_PATH,
  EditorialTransportError, editorialWireConfig, editorialPending,
  editorialLoopbackFetch, signedEditorialRequest, signedEditorialRevisionLookup,
  type EditorialWireConfig,
} from './editorial-signed-transport';
import { EditorialDeliveryService } from './editorial-delivery.service';
import { PostsRepository } from './posts.repository';
import type { EditorialScope } from './editorial-ingress';

const cfg: EditorialWireConfig = {
  orgId: 'org-a', requestKeyHex: 'a'.repeat(64), responseKeyHex: 'b'.repeat(64),
};
const scope: EditorialScope = {
  org_id: 'org-a', integration_id: 'max-a', campaign_id: 'campaign-a',
  channel_id: '42', profile_ref: 'life-stories@v5',
  is_test: true, image_mode: 'disabled',
};
const eid = '12345678-1234-4234-8234-123456789abc';
const payload = {
  schema_version: 1, event_id: eid, producer: 'postmill', actor_id: 'editor-a',
  occurred_at: '2026-11-20T00:00:00Z',
  binding: { task_id: '42', org_id: 'org-a', is_test: true, post_id: 'draft-a' },
  expected_seq: '0', action: 'approve_text',
  text: { revision: 1, sha256: 'f'.repeat(64) }, image: null,
  feedback: '', request_id: null, revision_content: null,
};
const row = {
  schema_version: 1, org_id: 'org-a', task_id: '42', event_id: eid,
  payload_sha256: 'c'.repeat(64), event: payload,
  dispatch_authorized: false as const, publishable: false as const,
};
const outcome = {
  status: 'accepted', reason: null,
  state: { seq: '1', binding: payload.binding, text: payload.text },
  dispatch_authorized: false, publishable: false,
  newly_applied: true, replay: false,
};
const S = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: string, msg: string) =>
  createHmac('sha256', Buffer.from(key, 'hex')).update(msg, 'ascii').digest('hex');

function mockedPeer(options?: {
  wrongSignature?: boolean; wrongHash?: boolean; badOutcome?: boolean;
  lookupMissing?: boolean; errorStatus?: number; large?: boolean;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8794\/internal\/editorial\/v1\/events\/(submit|lookup)$/);
    const headers = init?.headers as Record<string, string>;
    const ts = headers['x-edx-timestamp'];
    const nonce = headers['x-edx-nonce'];
    const raw = init?.body as string;
    const path = new URL(url).pathname;
    const reqMac = hmac(cfg.requestKeyHex, ['EDX1', 'REQ', path, ts, nonce, S(raw)].join('\n'));
    expect(headers['x-edx-signature']).toBe('sha256=' + reqMac);
    const parsed = JSON.parse(raw);
    if (path === EDITORIAL_SUBMIT_PATH) {
      expect(parsed.event).toEqual(payload);
    } else {
      expect(path).toBe(EDITORIAL_LOOKUP_PATH);
      expect(Object.hasOwn(parsed, 'event')).toBe(false);
    }
    const obj = path === EDITORIAL_SUBMIT_PATH
      ? { schema_version: 1, event_id: eid,
        payload_sha256: options?.wrongHash ? 'd'.repeat(64) : row.payload_sha256,
        outcome: options?.badOutcome ? { ...outcome, publishable: true } : outcome }
      : { schema_version: 1, event_id: eid, payload_sha256: row.payload_sha256,
        found: !options?.lookupMissing, outcome: options?.lookupMissing ? null : { ...outcome, newly_applied: false, replay: true } };
    const body = options?.large ? 'x'.repeat(32769) : JSON.stringify(obj);
    const mac = hmac(cfg.responseKeyHex,
      ['EDX1', 'RESP', path, ts, nonce, S(raw), S(body)].join('\n'));
    return new Response(body, {
      status: options?.errorStatus ?? 200,
      headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'x-edx-response-signature': 'sha256=' + (options?.wrongSignature ? '0'.repeat(64) : mac),
      },
    });
  }) as typeof editorialLoopbackFetch;
}

describe('06B-3C signed off-by-default editorial transport', () => {
  it('matches independent Python 014 known-answer vector byte-for-byte', () => {
    const path = EDITORIAL_LOOKUP_PATH;
    const ts = '1795160000', nonce = 'f'.repeat(32);
    const raw = '{"schema_version":1,"org_id":"org-a","task_id":"42","event_id":"' +
      eid + '","payload_sha256":"' + 'c'.repeat(64) + '"}';
    const response = '{"schema_version":1,"event_id":"' + eid +
      '","payload_sha256":"' + 'c'.repeat(64) + '","found":false,"outcome":null}';
    const requestMac = hmac(cfg.requestKeyHex,
      ['EDX1', 'REQ', path, ts, nonce, S(raw)].join('\n'));
    const responseMac = hmac(cfg.responseKeyHex,
      ['EDX1', 'RESP', path, ts, nonce, S(raw), S(response)].join('\n'));
    expect(requestMac).toBe('e358bbd1b4acf84d32806b33912ae3a069611fc907311aaf37affdb2357ba527');
    expect(responseMac).toBe('0c1935aa04433d0bd44d660a91b0fd1796a862d9ddd988325d28346469179cc4');
  });
  it('authenticates one exact request and signed outcome without network in tests', async () => {
    const fetcher = mockedPeer();
    const result = await signedEditorialRequest(row, cfg, 'submit', fetcher,
      1795160000000, 'f'.repeat(32));
    expect(result.event_id).toBe(eid);
    expect(result.outcome).toEqual(outcome);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reads a missing event as unknown, never rejection', async () => {
    const result = await signedEditorialRequest(row, cfg, 'lookup', mockedPeer({ lookupMissing: true }),
      1795160000000, 'f'.repeat(32));
    expect(result.found).toBe(false);
    expect(result.outcome).toBeNull();
  });
  it.each([
    { wrongSignature: true }, { wrongHash: true }, { badOutcome: true },
    { errorStatus: 503 }, { large: true },
  ])('rejects unauthentic, unsafe or ambiguous result as unknown: %j', async (options) => {
    await expect(signedEditorialRequest(row, cfg, 'submit', mockedPeer(options),
      1795160000000, 'f'.repeat(32))).rejects.toBeInstanceOf(EditorialTransportError);
  });
  it('pins the sole loopback peer and rejects any origin override and cross-org data', () => {
    expect(editorialWireConfig(cfg).origin).toBe(EDITORIAL_LOOPBACK_ORIGIN);
    for (const config of [
      { ...cfg, responseKeyHex: cfg.requestKeyHex },
      { ...cfg, origin: 'https://review-bridge.example.net' },
      { ...cfg, origin: 'http://127.0.0.1:8794' },
      { ...cfg, origin: 'http://127.0.0.2:8794' },
      { ...cfg, origin: 'http://169.254.169.254:8794' },
      { ...cfg, origin: 'http://localhost:8794' },
      { ...cfg, origin: 'http://127.0.0.1:8794/path' },
    ]) {
      expect(() => editorialWireConfig(config)).toThrow(EditorialTransportError);
    }
    expect(() => editorialPending(row, 'other', '42')).toThrow();
    expect(() => editorialPending({
      ...row, event: { ...payload, binding: { ...payload.binding, is_test: false } },
    }, 'org-a', '42')).toThrow();
  });
  it('rejects arbitrary destinations, methods and redirectable requests at the fetch boundary', async () => {
    for (const url of [
      'https://review-bridge.example.net/internal/editorial/v1/events/submit',
      'http://127.0.0.2:8794/internal/editorial/v1/events/submit',
      'http://localhost:8794/internal/editorial/v1/events/submit',
      'http://127.0.0.1:8795/internal/editorial/v1/events/submit',
      'http://127.0.0.1:8794/internal/editorial/v1/events/submit?next=evil',
      'http://127.0.0.1:8794/admin',
    ]) {
      await expect(editorialLoopbackFetch(url, { method: 'POST', redirect: 'error' }))
        .rejects.toBeInstanceOf(EditorialTransportError);
    }
    await expect(editorialLoopbackFetch(EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_SUBMIT_PATH, {
      method: 'GET', redirect: 'error',
    })).rejects.toBeInstanceOf(EditorialTransportError);
    await expect(editorialLoopbackFetch(EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_LOOKUP_PATH, {
      method: 'POST', redirect: 'follow',
    })).rejects.toBeInstanceOf(EditorialTransportError);
  });
  it('has no unreserved primary-submit entry point', () => {
    const svc = new EditorialDeliveryService({} as PostsRepository);
    expect('attemptOnce' in svc).toBe(false);
    expect('deliverReserved' in svc).toBe(false);
  });
  it('default reconciliation adapter is defined and does not touch the network without a pending event', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(null),
      importEditorialDecisionResult: vi.fn(),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    await expect(svc.reconcileOnce(scope, '42', 'test-channel', cfg))
      .resolves.toEqual({ status: 'no_pending' });
    expect(repo.readPendingEditorialDelivery).toHaveBeenCalledTimes(1);
    expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
  });
  it('does not resend on an unknown result; separate lookup does not submit', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(row),
      importEditorialDecisionResult: vi.fn().mockResolvedValue({ newly_recorded: true }),
      reserveEditorialSubmit: vi.fn()
        .mockResolvedValueOnce({ event_id: eid, newly_reserved: true })
        .mockResolvedValueOnce({ event_id: eid, newly_reserved: false }),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    const failingPeer = mockedPeer({ wrongSignature: true });
    await expect(svc.deliverPending(scope, '42', 'test-channel', cfg, failingPeer))
      .rejects.toBeInstanceOf(EditorialTransportError);
    expect(failingPeer).toHaveBeenCalledTimes(1);
    expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
    expect(vi.mocked(repo.reserveEditorialSubmit).mock.invocationCallOrder[0])
      .toBeLessThan((failingPeer as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    const missingPeer = mockedPeer({ lookupMissing: true });
    expect((await svc.deliverPending(scope, '42', 'test-channel', cfg, missingPeer)).status).toBe('unknown');
    expect(missingPeer).toHaveBeenCalledTimes(1);
    expect(repo.reserveEditorialSubmit).toHaveBeenCalledTimes(2);
    expect((missingPeer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(EDITORIAL_LOOKUP_PATH);
    expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
  });
  it('recovery requires an authenticated missing lookup, committed claim and the identical envelope', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(row),
      importEditorialDecisionResult: vi.fn().mockResolvedValue({ newly_recorded: true }),
      reserveEditorialSubmit: vi.fn().mockResolvedValue({ event_id: eid, newly_reserved: false }),
      reserveEditorialRecovery: vi.fn().mockResolvedValue(true),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    const peer = mockedPeer({ lookupMissing: true });
    const target = 'max:-73052031470103';
    const opt = { ...cfg, allowMissingRecovery: true };
    await expect(svc.deliverPending(scope, '42', target, opt, peer))
      .resolves.toMatchObject({ status: 'recorded', operation: 'submit' });
    expect(repo.reserveEditorialRecovery).toHaveBeenCalledWith(scope, '42', target, eid, row.payload_sha256);
    expect(peer).toHaveBeenCalledTimes(2);
    const calls = (peer as ReturnType<typeof vi.fn>).mock;
    expect(calls.calls[0][0]).toContain(EDITORIAL_LOOKUP_PATH);
    expect(calls.calls[1][0]).toContain(EDITORIAL_SUBMIT_PATH);
    const claimOrder = vi.mocked(repo.reserveEditorialRecovery).mock.invocationCallOrder[0];
    expect(calls.invocationCallOrder[0]).toBeLessThan(claimOrder);
    expect(claimOrder).toBeLessThan(calls.invocationCallOrder[1]);
    expect(repo.importEditorialDecisionResult).toHaveBeenCalledWith(scope, '42', target, eid, row.payload_sha256, outcome);
  });

  it.each(['disabled', 'wrong_target', 'denied', 'bad_signature', 'known', 'claim_error', 'changed'])(
    'does not recovery-submit when %s', async mode => {
      const repo = {
        readPendingEditorialDelivery: vi.fn().mockResolvedValue(row),
        importEditorialDecisionResult: vi.fn().mockResolvedValue({ newly_recorded: true }),
        reserveEditorialSubmit: vi.fn().mockResolvedValue({ event_id: eid, newly_reserved: false }),
        reserveEditorialRecovery: vi.fn().mockResolvedValue(mode !== 'denied'),
      } as unknown as PostsRepository;
      const svc = new EditorialDeliveryService(repo);
      const peer = mockedPeer({ lookupMissing: mode !== 'known', wrongSignature: mode === 'bad_signature' });
      if (mode === 'claim_error') vi.mocked(repo.reserveEditorialRecovery).mockRejectedValueOnce(new Error('unknown claim'));
      if (mode === 'changed') vi.mocked(repo.readPendingEditorialDelivery)
        .mockResolvedValueOnce(row).mockResolvedValueOnce(row)
        .mockResolvedValueOnce({ ...row, payload_sha256: 'd'.repeat(64) });
      const call = svc.deliverPending(scope, '42',
        mode === 'wrong_target' ? 'test-channel' : 'max:-73052031470103',
        { ...cfg, allowMissingRecovery: mode !== 'disabled' }, peer);
      if (['bad_signature', 'claim_error', 'changed'].includes(mode)) await expect(call).rejects.toThrow();
      else await expect(call).resolves.toMatchObject({ status: mode === 'known' ? 'recorded' : 'unknown', operation: 'lookup' });
      expect(peer).toHaveBeenCalledTimes(1);
      expect((peer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(EDITORIAL_LOOKUP_PATH);
      if (['disabled', 'wrong_target', 'bad_signature', 'known'].includes(mode))
        expect(repo.reserveEditorialRecovery).not.toHaveBeenCalled();
      if (mode !== 'known') expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
    },
  );

  it('imports only authenticated signed outcome and preserves exact event/hash', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(row),
      importEditorialDecisionResult: vi.fn().mockResolvedValue({ newly_recorded: true }),
      reserveEditorialSubmit: vi.fn().mockResolvedValue({ event_id: eid, newly_reserved: true }),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    const a = await svc.deliverPending(scope, '42', 'test-channel', cfg, mockedPeer());
    expect(a.status).toBe('recorded');
    expect(repo.importEditorialDecisionResult).toHaveBeenCalledWith(
      scope, '42', 'test-channel', eid, row.payload_sha256, outcome,
    );
    const b = await svc.reconcileOnce(scope, '42', 'test-channel', cfg, mockedPeer());
    expect(b.status).toBe('recorded');
    expect(repo.importEditorialDecisionResult).toHaveBeenCalledTimes(2);
  });
  it('short circuits no-pending and rejects cross-tenant without database access', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(null),
      importEditorialDecisionResult: vi.fn(),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    await expect(svc.deliverPending({ ...scope, org_id: 'other' }, '42',
      'test-channel', cfg, mockedPeer())).rejects.toThrow();
    expect(repo.readPendingEditorialDelivery).not.toHaveBeenCalled();
    const result = await svc.deliverPending(scope, '42', 'test-channel', cfg, mockedPeer());
    expect(result.status).toBe('no_pending');
    expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
  });
  it('reserved delivery refuses changed event identity before any network call', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(row),
      importEditorialDecisionResult: vi.fn(),
      reserveEditorialSubmit: vi.fn().mockResolvedValue({ event_id: 'changed', newly_reserved: true }),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    const peer = mockedPeer();
    await expect(svc.deliverPending(
      scope, '42', 'test-channel', cfg, peer,
    )).rejects.toBeInstanceOf(EditorialTransportError);
    expect(peer).not.toHaveBeenCalled();
    expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
  });

  it('reserved lookup cannot resend or invent remote acceptance', async () => {
    const repo = {
      readPendingEditorialDelivery: vi.fn().mockResolvedValue(row),
      importEditorialDecisionResult: vi.fn(),
      reserveEditorialSubmit: vi.fn().mockResolvedValue({ event_id: eid, newly_reserved: false }),
    } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    const peer = mockedPeer({ lookupMissing: true });
    await expect(svc.deliverPending(
      scope, '42', 'test-channel', cfg, peer,
    )).resolves.toMatchObject({ status: 'unknown', operation: 'lookup' });
    expect(peer).toHaveBeenCalledTimes(1);
    expect((peer as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain(EDITORIAL_LOOKUP_PATH);
    expect(repo.importEditorialDecisionResult).not.toHaveBeenCalled();
  });

});


describe('signed current revision reconciliation', () => {
  const request = { org_id: scope.org_id, task_id: '42', event_id: eid, payload_sha256: row.payload_sha256 };
  const content = { title: 'Revision', parts: ['a'.repeat(2900), 'b'.repeat(2900), 'c'.repeat(2900)] };
  const digest = S('{"parts": [' + content.parts.map(p => JSON.stringify(p)).join(', ') +
    '], "title": ' + JSON.stringify(content.title) + '}');
  const installId = '22345678-1234-4234-8234-123456789abc';
  const proof = {
    install_event_id: installId, install_payload_sha256: 'e'.repeat(64),
    install_event: { event_id: installId, producer: 'operator', action: 'install_text',
      request_id: eid, binding: payload.binding, revision_content: content },
    state: { seq: '2', image_mode: 'disabled', text_status: 'pending',
      text: { revision: 2, sha256: digest }, final_approved: false, rejected: false,
      publishable: false, dispatch_authorized: false },
    publishable: false, dispatch_authorized: false,
  };
  function revisionPeer(value: unknown = proof, badSignature = false) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(EDITORIAL_LOOPBACK_ORIGIN + EDITORIAL_REVISION_LOOKUP_PATH);
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      const raw = init?.body as string;
      const ts = headers['x-edx-timestamp'], nonce = headers['x-edx-nonce'];
      expect(JSON.parse(raw)).toEqual({ schema_version: 1, ...request });
      expect(headers['x-edx-signature']).toBe('sha256=' + hmac(cfg.requestKeyHex,
        ['EDX1','REQ',EDITORIAL_REVISION_LOOKUP_PATH,ts,nonce,S(raw)].join('\n')));
      const response = JSON.stringify({ schema_version: 1, event_id: eid,
        payload_sha256: row.payload_sha256, found: value !== null, proof: value });
      return new Response(response, { headers: {
        'content-type': 'application/json', 'cache-control': 'no-store',
        'x-edx-response-signature': 'sha256=' + (badSignature ? '0'.repeat(64) : hmac(cfg.responseKeyHex,
          ['EDX1','RESP',EDITORIAL_REVISION_LOOKUP_PATH,ts,nonce,S(raw),S(response)].join('\n'))),
      } });
    }) as typeof editorialLoopbackFetch;
  }
  it('authenticates exact read-only proof and distinguishes missing revision', async () => {
    await expect(signedEditorialRevisionLookup(request,cfg,revisionPeer())).resolves.toEqual(proof);
    await expect(signedEditorialRevisionLookup(request,cfg,revisionPeer(null))).resolves.toBeNull();
  });
  it('refuses wrong HMAC or unauthorized proof', async () => {
    await expect(signedEditorialRevisionLookup(request,cfg,revisionPeer(proof,true))).rejects.toThrow();
    await expect(signedEditorialRevisionLookup(request,cfg,revisionPeer({ ...proof, publishable: true }))).rejects.toThrow();
    await expect(signedEditorialRevisionLookup(request,cfg,revisionPeer({
      ...proof, install_event: { ...proof.install_event, request_id: installId },
    }))).rejects.toThrow();
  });
  it('imports only the signed and independently content-validated proof', async () => {
    const repo = { importEditorialTextRevision: vi.fn().mockResolvedValue({ installed: true }) } as unknown as PostsRepository;
    const svc = new EditorialDeliveryService(repo);
    const target = 'max:-73052031470103';
    await expect(svc.reconcileTextRevision(scope,'42',target,eid,row.payload_sha256,cfg,revisionPeer(null)))
      .resolves.toEqual({ status: 'not_ready' });
    expect(repo.importEditorialTextRevision).not.toHaveBeenCalled();
    await expect(svc.reconcileTextRevision(scope,'42',target,eid,row.payload_sha256,cfg,revisionPeer()))
      .resolves.toMatchObject({ status: 'recorded' });
    expect(repo.importEditorialTextRevision).toHaveBeenCalledWith(scope,'42',target,eid,row.payload_sha256,proof);
    await expect(svc.reconcileTextRevision(scope,'42',target,eid,row.payload_sha256,cfg,revisionPeer({
      ...proof, install_event: { ...proof.install_event, revision_content: { ...content, title: 'Tampered' } },
    }))).rejects.toThrow();
    expect(repo.importEditorialTextRevision).toHaveBeenCalledTimes(1);
  });
});
