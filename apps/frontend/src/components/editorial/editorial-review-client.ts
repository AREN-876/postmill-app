import type {
  EditorialHumanCommand,
  EditorialQueueReceipt,
  EditorialReviewSnapshot,
} from './editorial-review-panel';

// A narrow API client. It is NOT a public API client or a route installer.
// The caller MUST supply the existing session/cookie+CSRF useFetch transport.
type Fetcher = (url: string, options?: RequestInit) => Promise<Response>;
const POST_ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIONS = new Set(['approve_text', 'request_text_changes', 'reject', 'request_image', 'request_image_changes', 'confirm_image_reuse', 'approve_final']);
const MAX_TASK = '9223372036854775807';

function record(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function path(postId: string, taskId: string): string {
  if (!POST_ID.test(postId) || !TASK_ID.test(taskId) ||
      (taskId.length === 19 && taskId > MAX_TASK)) {
    throw new Error('editorial_invalid_identity');
  }
  // The Postmill standard fetch wrapper can accept a "loggedAuth" URL query
  // parameter and add a header-auth credential. Human review requires COOKIE
  // session only: refuse before invoking fetch instead of leaking/falling back.
  if (typeof window !== 'undefined' &&
      new URL(window.location.href).searchParams.has('loggedAuth')) {
    throw new Error('editorial_cookie_session_required');
  }
  return `/editorial/review/${postId}/${taskId}`;
}

function checkedSnapshot(x: unknown, postId: string, taskId: string): EditorialReviewSnapshot {
  if (!record(x) || x.post_id !== postId || x.task_id !== taskId ||
      x.review_acknowledged !== true ||
      x.publishable !== false || x.dispatch_authorized !== false ||
      x.remote_current_verified !== false || !record(x.content) ||
      typeof x.content.title !== 'string' || !x.content.title.trim() ||
      !Array.isArray(x.content.parts) || x.content.parts.length !== 3 ||
      !x.content.parts.every(v => typeof v === 'string' && v.trim()) ||
      !record(x.review) || typeof x.review.status !== 'string') {
    throw new Error('editorial_untrusted_snapshot');
  }
  if (x.review.last_confirmed_state !== null &&
      x.review.last_confirmed_state !== undefined) {
    const state = x.review.last_confirmed_state;
    if (!record(state) || typeof state.seq !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(state.seq) ||
        (state.seq.length === 19 && state.seq > MAX_TASK)) {
      throw new Error('editorial_untrusted_snapshot');
    }
  }
  if (x.mock_image !== undefined) {
    const m=x.mock_image;
    if (!record(m) || !['waiting','recorded','uncertain','unavailable'].includes(m.status as string) ||
        typeof m.can_import !== 'boolean' || (m.asset !== null && (!record(m.asset) ||
        typeof m.asset.file_id !== 'string' || !UUID.test(m.asset.file_id) ||
        typeof m.asset.revision !== 'number' || !Number.isSafeInteger(m.asset.revision) || m.asset.revision<1 ||
        typeof m.asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(m.asset.sha256) ||
        typeof m.asset.compatible !== 'boolean' ||
        m.asset.png_base64 !== 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg=='))) {
      throw new Error('editorial_untrusted_image');
    }
    const state = x.review.last_confirmed_state;
    if ((m.status === 'recorded' && m.asset === null) || (m.asset !== null &&
        (!record(m.asset) || !record(state) || !record(state.image) ||
         state.image.revision !== m.asset.revision || state.image_compatible !== m.asset.compatible))) {
      throw new Error('editorial_untrusted_image');
    }
  }
  if (x.live_image_preview_enabled !== undefined &&
      (x.live_image_preview_enabled !== true || x.mock_image !== undefined)) {
    throw new Error('editorial_untrusted_image_capability');
  }
  if (x.live_image_mutations_enabled !== undefined &&
      (x.live_image_mutations_enabled !== true || x.live_image_preview_enabled !== true || x.mock_image !== undefined))
    throw new Error('editorial_untrusted_image_capability');
  return x as EditorialReviewSnapshot;
}

function checkedCommand(cmd: EditorialHumanCommand): void {
  if (!record(cmd) || Object.keys(cmd).length !== 4 ||
      !['command_id', 'expected_seq', 'action', 'feedback'].every(key => Object.hasOwn(cmd, key)) ||
      typeof cmd.command_id !== 'string' || !UUID.test(cmd.command_id) ||
      typeof cmd.expected_seq !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(cmd.expected_seq) ||
      (cmd.expected_seq.length === 19 && cmd.expected_seq > MAX_TASK) ||
      !ACTIONS.has(cmd.action) || typeof cmd.feedback !== 'string' ||
      cmd.feedback.length > 4000 || new TextEncoder().encode(cmd.feedback).length > 16000 ||
      (['request_text_changes','request_image_changes'].includes(cmd.action) ? !cmd.feedback.trim() : cmd.feedback !== '')) {
    throw new Error('editorial_invalid_command');
  }
}

export function editorialReviewClient(fetcher: Fetcher) {
  return {
    async read(postId: string, taskId: string): Promise<EditorialReviewSnapshot> {
      const url = path(postId, taskId);
      const res = await fetcher(url, { method: 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error('editorial_review_read_unavailable');
      const data: unknown = await res.json();
      return checkedSnapshot(data, postId, taskId);
    },
    async previewLiveImage(postId: string, taskId: string, seq: string, signal?: AbortSignal): Promise<Blob> {
      const url = path(postId, taskId);
      if (!/^(0|[1-9][0-9]{0,18})$/.test(seq) ||
          (seq.length === 19 && seq > MAX_TASK)) throw new Error('editorial_invalid_identity');
      const res = await fetcher(url + '/live-image/preview', {
        method: 'POST', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Accept: 'image/jpeg' }, body: JSON.stringify({ expected_seq: seq }), signal,
      });
      const maxBytes = 8 * 1024 * 1024;
      const length = res.headers.get('content-length');
      if (!res.ok || res.redirected || res.headers.get('content-type') !== 'image/jpeg' ||
          (length !== null && (!/^[0-9]+$/.test(length) || Number(length) < 4 || Number(length) > maxBytes)) ||
          !res.body) throw new Error('editorial_image_preview_unavailable');
      const reader = res.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error('editorial_image_preview_unavailable');
          const copy = new Uint8Array(value.byteLength);
          copy.set(value);
          chunks.push(copy.buffer);
        }
        if (size < 4 || (length !== null && size !== Number(length)) || signal?.aborted)
          throw new Error('editorial_image_preview_unavailable');
        return new Blob(chunks, { type: 'image/jpeg' });
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
    async importImage(postId:string,taskId:string,seq:string,live=false): Promise<{status:string}> {
      const url=path(postId,taskId);
      if (!/^(0|[1-9][0-9]{0,18})$/.test(seq) ||
          (seq.length === 19 && seq > MAX_TASK)) throw new Error('editorial_invalid_identity');
      const res=await fetcher(url+(live ? '/live-image/import' : '/image/import'),{
        method:'POST',cache:'no-store',redirect:'error',body:JSON.stringify({expected_seq:seq})});
      if (!res.ok) throw new Error('editorial_image_outcome_unknown');
      const x:unknown=await res.json();
      if (!record(x) || !['recorded','not_ready','uncertain'].includes(x.status as string) ||
          x.publishable!==false || x.dispatch_authorized!==false) throw new Error('editorial_image_outcome_unknown');
      return {status:x.status as string};
    },
    async queue(
      postId: string, taskId: string, command: EditorialHumanCommand, live=false,
    ): Promise<EditorialQueueReceipt> {
      const url = path(postId, taskId);
      checkedCommand(command);
      // Never retry a mutating request, even if the network throws or the
      // response is invalid. The caller must reconcile with read() only.
      const res = await fetcher(url + (live ? '/live-image/decisions' : '/decisions'), {
        method: 'POST', cache: 'no-store', redirect:'error',
        body: JSON.stringify(command),
      });
      if (!res.ok) throw new Error('editorial_queue_outcome_unknown');
      const data: unknown = await res.json();
      if (!record(data) || data.status !== 'queued/unconfirmed' ||
          data.dispatch_authorized !== false || data.publishable !== false ||
          typeof data.event_id !== 'string' || !UUID.test(data.event_id)) {
        throw new Error('editorial_queue_outcome_unknown');
      }
      return {
        status: 'queued/unconfirmed',
        dispatch_authorized: false,
        publishable: false,
      };
    },
  };
}
