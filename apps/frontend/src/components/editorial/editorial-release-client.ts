import type { EditorialReviewSnapshot } from './editorial-review-panel';

// Session-cookie and CSRF transport is injected from Postmill useFetch.
// This client never sends credentials or selects a MAX target.
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type EditorialReleaseMode = 'publish_now' | 'queue';
export type EditorialReleaseCommand = {
  command_id: string;
  action: EditorialReleaseMode;
  publish_at: string | null;
};
export type ReleasePreview = {
  ready: boolean;
  status: 'not_finally_approved' | 'available' | 'already_released';
  next_slot?: {
    integrationId: string;
    publishAt: string;
    localTime: string;
    timezone: 'Europe/Moscow';
  };
  release_post_id?: string;
  publish_at?: string;
};
export type ReleaseAccepted = {
  created: boolean;
  status: 'native_dispatch_requested' | 'already_recorded';
  source_post_id: string;
  publication_post_id: string;
  mode: EditorialReleaseMode;
  publish_at: string;
  max_delivery_confirmed: false;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POST_ID = /^[0-9a-f]{32}$/;
const TASK = /^[1-9][0-9]{0,18}$/;
function record(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}
function path(postId: string, taskId: string) {
  if (!POST_ID.test(postId) || !TASK.test(taskId) ||
      (taskId.length === 19 && taskId > '9223372036854775807')) {
    throw new Error('editorial_invalid_identity');
  }
  if (typeof window !== 'undefined' &&
      new URL(window.location.href).searchParams.has('loggedAuth')) {
    throw new Error('editorial_cookie_session_required');
  }
  return `/editorial/release/${postId}/${taskId}`;
}

export function canOfferEditorialRelease(snapshot: EditorialReviewSnapshot): boolean {
  const state = snapshot.review?.last_confirmed_state;
  return snapshot.review_acknowledged === true &&
    snapshot.review?.status === 'idle' &&
    state?.final_approved === true && state?.rejected === false &&
    state?.image_mode === 'disabled' &&
    state?.text_status === 'approved' &&
    snapshot.content?.parts?.length === 3 &&
    snapshot.publishable === false &&
    snapshot.dispatch_authorized === false;
}
export function editorialReleaseClient(fetcher: Fetcher) {
  return {
    async preview(postId: string, taskId: string): Promise<ReleasePreview> {
      const res = await fetcher(path(postId, taskId) + '/preview', {
        method: 'GET', cache: 'no-store',
      });
      if (!res.ok) throw new Error('editorial_release_preview_unavailable');
      const x: unknown = await res.json();
      if (!record(x) || typeof x.ready !== 'boolean' ||
          !['not_finally_approved', 'available', 'already_released'].includes(String(x.status))) {
        throw new Error('editorial_release_preview_untrusted');
      }
      if (x.status === 'available') {
        const slot = x.next_slot;
        if (x.ready !== true || !record(slot) ||
            typeof slot.publishAt !== 'string' || !Number.isFinite(Date.parse(slot.publishAt)) ||
            typeof slot.localTime !== 'string' || slot.timezone !== 'Europe/Moscow' ||
            typeof slot.integrationId !== 'string' || !slot.integrationId) {
          throw new Error('editorial_release_preview_untrusted');
        }
      }
      if (x.status === 'already_released' &&
          (x.ready !== false || typeof x.release_post_id !== 'string' ||
           !POST_ID.test(x.release_post_id))) {
        throw new Error('editorial_release_preview_untrusted');
      }
      return x as ReleasePreview;
    },
    async submit(postId: string, taskId: string, command: EditorialReleaseCommand): Promise<ReleaseAccepted> {
      const url = path(postId, taskId);
      if (!record(command) || Object.keys(command).length !== 3 ||
          typeof command.command_id !== 'string' || !UUID.test(command.command_id) ||
          (command.action !== 'publish_now' && command.action !== 'queue') ||
          (command.action === 'publish_now' ? command.publish_at !== null :
            typeof command.publish_at !== 'string' ||
            !/^20\d\d-\d\d-\d\dT\d\d:\d\d:00(?:\.000)?Z$/.test(command.publish_at))) {
        throw new Error('editorial_release_invalid');
      }
      // One POST at most. Unknown result is never resent by this client.
      const res = await fetcher(url, {
        method: 'POST', cache: 'no-store',
        body: JSON.stringify(command),
      });
      if (!res.ok) throw new Error('editorial_release_outcome_unknown');
      const x: unknown = await res.json();
      if (!record(x) || typeof x.created !== 'boolean' ||
          !['native_dispatch_requested', 'already_recorded'].includes(String(x.status)) ||
          x.source_post_id !== postId ||
          typeof x.publication_post_id !== 'string' || !POST_ID.test(x.publication_post_id) ||
          x.mode !== command.action || typeof x.publish_at !== 'string' ||
          x.max_delivery_confirmed !== false) {
        throw new Error('editorial_release_outcome_unknown');
      }
      return x as ReleaseAccepted;
    },
  };
}
