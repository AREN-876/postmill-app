import { isDeepStrictEqual } from 'node:util';
import { v5 as uuidv5 } from 'uuid';
import { EditorialPrivateImageStore } from './editorial-private-image';
import { validateEditorialLiveJpeg } from './editorial-live-jpeg';
import { checkEditorialLivePreview, type EditorialWireConfig, type EditorialLiveImageRequest, type EditorialLiveReviewPin, type EditorialLiveImageAsset } from './editorial-signed-transport';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POST=/^[0-9a-f]{32}$/;
const OCCURRENCE=/^max_[0-9a-f]{64}$/;
const SHA=/^[0-9a-f]{64}$/;
function record(x:unknown): x is Record<string,unknown> {
  return x!==null && typeof x==='object' && !Array.isArray(x);
}
function int64(x:unknown): x is string {
  return typeof x==='string' && /^[1-9][0-9]{0,18}$/.test(x) && (x.length<19 || x<='9223372036854775807');
}
function uuid(x:unknown): x is string { return typeof x==='string' && UUID.test(x); }
function sha(x:unknown): x is string { return typeof x==='string' && SHA.test(x); }
function denied(): never { throw new Error('editorial_release_photo_unavailable'); }

export type PrivateReleasePhotoIdentity = { orgId:string; publicationPostId:string; occurrenceId:string; attempt:1 };
type Dependencies = {
  // Must be a fresh native projection, not browser data, a cached job payload,
  // or a generic File lookup. No runtime projection wired at this stage.
  read: (identity:PrivateReleasePhotoIdentity)=>Promise<unknown>;
  open: ()=>Promise<Pick<EditorialPrivateImageStore,'read'>>;
  wire: EditorialWireConfig;
  check?: typeof checkEditorialLivePreview;
};

// Inactive preflight candidate. No occurrence claim, send grant, enqueue,
// upload or MAX call. A later native one-use occurrence must authorize
// transport. Read authority cannot cancel a send after its last check.
export async function prepareEditorialPrivateReleasePhoto(identity:PrivateReleasePhotoIdentity,deps:Dependencies) {
  try {
    if (identity.orgId!=='org-modes' || !POST.test(identity.publicationPostId) ||
        !OCCURRENCE.test(identity.occurrenceId) || identity.attempt!==1) denied();
    const p=await deps.read(identity);
    if (!record(p) || p.publication_post_id!==identity.publicationPostId ||
        typeof p.source_post_id!=='string' || !POST.test(p.source_post_id) ||
        p.source_post_id===p.publication_post_id || p.occurrence_id!==identity.occurrenceId ||
        p.attempt!==identity.attempt || p.target!=='max:-73052031470103' || !sha(p.fingerprint) ||
        p.publishable!==false || p.dispatch_authorized!==false || !record(p.request) ||
        p.request.org_id!==identity.orgId || !int64(p.request.task_id) || !int64(p.request.channel_id) ||
        !record(p.request.state) || !record(p.pin) || !record(p.media)) denied();
    const s=p.request.state, m=p.media, a=m.asset, pin=p.pin;
    if (!int64(p.confirmed_seq) || s.seq!==p.confirmed_seq || s.final_approved!==true ||
        s.rejected!==false || s.text_status!=='approved' || s.image_compatible!==true ||
        s.image_intent!==null || s.text_request_id!==null || s.publishable!==false ||
        s.dispatch_authorized!==false || !record(s.binding) || s.binding.post_id!==p.source_post_id ||
        s.binding.org_id!==identity.orgId || s.binding.task_id!==p.request.task_id || s.binding.is_test!==true ||
        !record(s.image) || !sha(s.image.sha256) || typeof s.image.revision!=='number' ||
        !Number.isSafeInteger(s.image.revision) || s.image.revision<1 ||
        m.revision!==s.image.revision || !record(a) || !uuid(a.plan_id) || !uuid(a.asset_id) ||
        !uuid(m.file_id) || pin.plan_id!==a.plan_id || pin.native_file_id!==m.file_id ||
        !sha(a.sha256) || pin.asset_sha256!==a.sha256 || m.sha256!==a.sha256 ||
        a.mime!=='image/jpeg' || m.mime!=='image/jpeg' ||
        typeof a.size_bytes!=='number' || !Number.isSafeInteger(a.size_bytes) ||
        a.size_bytes<4 || a.size_bytes>8*1024*1024 || m.size_bytes!==a.size_bytes ||
        typeof m.path!=='string' || !/^editorial-private:v1:[0-9a-f-]{36}\.jpg$/.test(m.path)) denied();
    const request=p.request as EditorialLiveImageRequest;
    const nativePin=pin as EditorialLiveReviewPin;
    const check=deps.check ?? checkEditorialLivePreview;
    if (!await check(request,nativePin,deps.wire)) denied();
    const store=await deps.open();
    const bytes=await store.read(m.path,a.size_bytes);
    await validateEditorialLiveJpeg(bytes,a as EditorialLiveImageAsset);
    if (!isDeepStrictEqual(p,await deps.read(identity)) ||
        !await check(request,nativePin,deps.wire) ||
        !isDeepStrictEqual(p,await deps.read(identity))) denied();
    return { image:{base64:bytes.toString('base64'),mimeType:'image/jpeg' as const,sha256:a.sha256},
      publication_post_id:identity.publicationPostId,occurrence_id:identity.occurrenceId,
      attempt:identity.attempt,remote_current_verified:true as const,
      dispatch_authorized:false as const,publishable:false as const };
  } catch { return denied(); }
}

type ClaimResult = {attempt?:number;occurrenceId?:string;blocked?:boolean;deferred?:boolean;alreadyConfirmed?:boolean};
type HandoffDependencies = Dependencies & {
  // These ports are deliberately not registered. claim must be the committed
  // existing native CAS, not a lookup of an already STARTED journal.
  claim: (identity:PrivateReleasePhotoIdentity, operationId:string, photoSha256:string)=>Promise<ClaimResult|null>;
  readStarted: (identity:PrivateReleasePhotoIdentity,operationId:string)=>Promise<unknown>;
  hold: (identity:PrivateReleasePhotoIdentity)=>Promise<void>;
  send: (payload:{operationId:string;externalPostId:string;revision:string;image:{base64:string;mimeType:'image/jpeg';sha256:string}},
    authority: { fingerprint:string; beforePublication: (receipt: {sha256:string; bytes:number; mime_type:'image/jpeg'}) =>
      Promise<{allowed:true}|{allowed:false}> })=>Promise<void>;
};

// Inactive same-invocation orchestration candidate. A read of STARTED is
// never sufficient to enter this function or resume a send. Unknown claim
// response is fenced by native state; no retry or reopening on any failure.
// The caller must not persist the in-memory photo or expose this as an RPC.
export async function qualifyPrivateReleaseHandoff(identity:PrivateReleasePhotoIdentity,deps:HandoffDependencies) {
  let snapshot:unknown;
  const photo=await prepareEditorialPrivateReleasePhoto(identity,{...deps,read:async id=>{
    const current=await deps.read(id);
    if(snapshot===undefined) snapshot=structuredClone(current);
    return current;
  }});
  const operationId=uuidv5('postmill:max:occurrence:'+identity.occurrenceId,uuidv5.URL);
  const claim=await deps.claim(identity,operationId,photo.image.sha256);
  if(!claim || claim.blocked || claim.deferred || claim.alreadyConfirmed ||
      claim.attempt!==1 || claim.occurrenceId!==identity.occurrenceId) return {status:'not_claimed' as const};
  try {
    if(!record(snapshot)||!record(snapshot.request)||!record(snapshot.pin)||
      !isDeepStrictEqual(snapshot,await deps.readStarted(identity,operationId))||
      !await (deps.check??checkEditorialLivePreview)(snapshot.request as EditorialLiveImageRequest,
        snapshot.pin as EditorialLiveReviewPin,deps.wire)||
      !isDeepStrictEqual(snapshot,await deps.readStarted(identity,operationId))) denied();
    // Only this fresh committed claim can create a one-shot final callback.
    const expected=structuredClone(snapshot);
    if(!sha(expected.fingerprint)) denied();
    let used=false;
    const beforePublication=async(receipt:{sha256:string;bytes:number;mime_type:'image/jpeg'}):
      Promise<{allowed:true}|{allowed:false}>=>{
      if(used) return {allowed:false};
      used=true;
      try {
        if(receipt.sha256!==photo.image.sha256 || receipt.mime_type!=='image/jpeg' ||
            receipt.bytes!==Buffer.byteLength(photo.image.base64,'base64') ||
            !isDeepStrictEqual(expected,await deps.readStarted(identity,operationId)) ||
            !await (deps.check??checkEditorialLivePreview)(expected.request as EditorialLiveImageRequest,
              expected.pin as EditorialLiveReviewPin,deps.wire) ||
            !isDeepStrictEqual(expected,await deps.readStarted(identity,operationId))) return {allowed:false};
        return {allowed:true};
      } catch { return {allowed:false}; }
    };
    await deps.send({operationId,externalPostId:identity.publicationPostId,
      revision:identity.occurrenceId,image:photo.image},{fingerprint:expected.fingerprint,beforePublication});
    return {status:'handoff_returned' as const};
  } catch {
    // No resend, no READY reset. Completion/reconciliation is native-owned.
    try {await deps.hold(identity);} catch { /* durable STARTED still fences */ }
    return {status:'held' as const};
  }
}
