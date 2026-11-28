import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { EditorialPrivateImageStore, editorialPrivateImageKey } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-private-image';
import { EditorialLiveImageService, liveImageImportEnabled } from './editorial-live-image.service';
import { createHash } from 'node:crypto';
import type { fetchEditorialLiveImage } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-signed-transport';

const org='org-modes',pid='a'.repeat(32),task='42',target='max:-73052031470103';
const id='11111111-1111-4111-8111-111111111111';
const token='22222222-2222-4222-8222-222222222222';
const path=editorialPrivateImageKey(id);
import { makeLiveJpegFixture } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-live-jpeg.fixture';
let jpeg:Buffer;
let sha:string;

const state={seq:'0',rejected:false,final_approved:false,image_compatible:false,image_intent:'initial:1',image_mode:'automatic',text_status:'pending'};
const ctx={scope:{org_id:org,channel_id:'12'},state,status:'idle',media:null};
const flags={publishable:false,dispatch_authorized:false};
const posts={readLiveImageContext:vi.fn(),reserveLiveImageImport:vi.fn(),finishLiveImageImport:vi.fn()};
const adapter={type:'LOCAL',writeBuffer:vi.fn(),readFileStream:vi.fn(),removeFile:vi.fn()};
const privateStore={write:vi.fn(),read:vi.fn()};
const storage={getBaseAdapterForOrg:vi.fn(),assertWithinProviderQuota:vi.fn()};
const fetchImage=vi.fn();
const check=vi.fn();
let proof: {manifest: [{asset_id:string;plan_id:string;sha256:string;mime:'image/jpeg';width:number;height:number;size_bytes:number;provider:'fal';model:string}]};
const wire=()=>({orgId:org,requestKeyHex:'a'.repeat(64),responseKeyHex:'b'.repeat(64),allowLiveImageRead:true});
const svc=new EditorialLiveImageService(posts as never,storage as never);
const call=()=>svc.import(org,pid,task,target,'0',wire,fetchImage as typeof fetchEditorialLiveImage);

describe('native fixture image import',()=>{
 beforeEach(async()=>{
  jpeg=await makeLiveJpegFixture();
  sha=createHash('sha256').update(jpeg).digest('hex');
  proof={manifest:[{asset_id:id,plan_id:token,sha256:sha,mime:'image/jpeg',width:1152,height:768,size_bytes:jpeg.length,provider:'fal',model:'fal-ai/flux-2/klein/9b'}]};
  vi.resetAllMocks();
  vi.spyOn(EditorialPrivateImageStore,'open').mockResolvedValue(privateStore as never);
  vi.stubEnv('EDITORIAL_TEST_SESSION_ENABLED','true');vi.stubEnv('EDITORIAL_TEST_ORG_ID',org);
  vi.stubEnv('EDITORIAL_TEST_MAX_TARGET',target);vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_IMPORT_ENABLED','true');
  posts.readLiveImageContext.mockResolvedValue(ctx);
  posts.reserveLiveImageImport.mockResolvedValue({status:'reserved',import_id:id,token,...flags});
  posts.finishLiveImageImport.mockResolvedValue({status:'recorded',file_id:id,...flags});
  storage.getBaseAdapterForOrg.mockResolvedValue(adapter);
  storage.assertWithinProviderQuota.mockResolvedValue(undefined);
  privateStore.write.mockResolvedValue(path);
  privateStore.read.mockImplementation(async()=>jpeg);
  fetchImage.mockResolvedValue({proof,bytes:jpeg});
  check.mockResolvedValue(true);
  vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_REVIEW_ENABLED','true');
  vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED','false');
 });
 afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
 it('requires dedicated opt-in and exact disposable scope',async()=>{
  expect(liveImageImportEnabled(org,target)).toBe(true);
  expect(liveImageImportEnabled('other',target)).toBe(false);
  vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_IMPORT_ENABLED','false');
  await expect(call()).rejects.toThrow('editorial_image_import_disabled');
  expect(posts.readLiveImageContext).not.toHaveBeenCalled();
 });
 it('commits reservation before write, verifies native bytes before receipt',async()=>{
  expect(await call()).toEqual({status:'recorded',...flags});
  expect(posts.reserveLiveImageImport).toHaveBeenCalledWith(org,pid,task,target,proof);
  expect(privateStore.write).toHaveBeenCalledExactlyOnceWith(id,jpeg);
  expect(posts.reserveLiveImageImport.mock.invocationCallOrder[0]).toBeLessThan(privateStore.write.mock.invocationCallOrder[0]);
  expect(privateStore.read.mock.invocationCallOrder[0]).toBeLessThan(posts.finishLiveImageImport.mock.invocationCallOrder[0]);
  expect(posts.finishLiveImageImport).toHaveBeenCalledWith(org,pid,task,target,id,token,path,sha,jpeg.length);
  expect(adapter.writeBuffer).not.toHaveBeenCalled();
  expect(adapter.readFileStream).not.toHaveBeenCalled();
  expect(fetchImage).toHaveBeenCalledTimes(3);
  expect(fetchImage.mock.invocationCallOrder[1]).toBeGreaterThan(posts.reserveLiveImageImport.mock.invocationCallOrder[0]);
  expect(fetchImage.mock.invocationCallOrder[1]).toBeLessThan(privateStore.write.mock.invocationCallOrder[0]);
  expect(fetchImage.mock.invocationCallOrder[2]).toBeGreaterThan(privateStore.read.mock.invocationCallOrder[0]);
  expect(fetchImage.mock.invocationCallOrder[2]).toBeLessThan(posts.finishLiveImageImport.mock.invocationCallOrder[0]);
 });
 it('never writes on not-ready or unresolved reservation',async()=>{
  fetchImage.mockResolvedValueOnce(null);
  expect(await call()).toEqual({status:'not_ready',...flags});
  posts.reserveLiveImageImport.mockResolvedValueOnce({status:'uncertain',...flags});
  expect(await call()).toEqual({status:'uncertain',...flags});
  expect(privateStore.write).not.toHaveBeenCalled();
  expect(posts.finishLiveImageImport).not.toHaveBeenCalled();
 });
 it('does not remove or repeat writes after native storage or SQL failure',async()=>{
  privateStore.read.mockResolvedValueOnce(Buffer.from('tampered'));
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.finishLiveImageImport).not.toHaveBeenCalled();
  posts.readLiveImageContext.mockResolvedValueOnce({...ctx,status:'image_import_uncertain'});
  expect(await call()).toEqual({status:'uncertain',...flags});
  expect(privateStore.write).toHaveBeenCalledTimes(1);
  expect(adapter.removeFile).not.toHaveBeenCalled();
 });
 it('blocks before writing when the signed proof has advanced after reservation',async()=>{
  fetchImage.mockResolvedValueOnce({proof,bytes:jpeg}).mockResolvedValueOnce(null);
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.reserveLiveImageImport).toHaveBeenCalledTimes(1);
  expect(privateStore.write).not.toHaveBeenCalled();
  expect(posts.finishLiveImageImport).not.toHaveBeenCalled();
 });
 it('does not confirm storage when the signed proof changes after read-back',async()=>{
  fetchImage.mockResolvedValueOnce({proof,bytes:jpeg}).mockResolvedValueOnce({proof,bytes:jpeg})
    .mockResolvedValueOnce({proof:{fixture:'changed'},bytes:jpeg});
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(privateStore.write).toHaveBeenCalledTimes(1);
  expect(posts.finishLiveImageImport).not.toHaveBeenCalled();
  expect(adapter.removeFile).not.toHaveBeenCalled();
 });
 it('fails before reservation if private storage is not provisioned',async()=>{
  vi.mocked(EditorialPrivateImageStore.open).mockRejectedValueOnce(Error('missing root'));
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.reserveLiveImageImport).not.toHaveBeenCalled();
  expect(privateStore.write).not.toHaveBeenCalled();
 });
 it('does not reserve with an unsupported adapter or quota rejection',async()=>{
  storage.getBaseAdapterForOrg.mockResolvedValueOnce({...adapter,type:'S3'});
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  storage.assertWithinProviderQuota.mockRejectedValueOnce(Error('quota'));
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.reserveLiveImageImport).not.toHaveBeenCalled();
  expect(privateStore.write).not.toHaveBeenCalled();
 });
 it('refuses marker-only JPEG even with matching digest before reservation',async()=>{
  const bad=Buffer.from('ffd8ffd9','hex');
  fetchImage.mockResolvedValueOnce({bytes:bad,proof:{manifest:[{...proof.manifest[0],sha256:createHash('sha256').update(bad).digest('hex'),size_bytes:bad.length}]}});
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.reserveLiveImageImport).not.toHaveBeenCalled();
  expect(privateStore.write).not.toHaveBeenCalled();
 });

 it('preview is opt-in, exact locally confirmed native JPEG, and never returns a path',async()=>{
  const installed={...state,seq:'1',image:{revision:1,sha256:'c'.repeat(64)},image_intent:null,image_compatible:true};
  const current={...ctx,state:installed,media:{file_id:id,path,sha256:sha,size_bytes:jpeg.length,mime:'image/jpeg',revision:1,asset:proof.manifest[0]}};
  posts.readLiveImageContext.mockResolvedValue(current);
  expect(await svc.preview(org,pid,task,target,installed,wire,check)).toBeUndefined();
  expect(posts.readLiveImageContext).not.toHaveBeenCalled();
  vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED','true');
  const preview=await svc.preview(org,pid,task,target,installed,wire,check);
  expect(preview).toEqual({bytes:jpeg,mime:'image/jpeg',file_id:id,revision:1,sha256:sha,compatible:true,
    remote_current_verified:true,...flags});
  expect(posts.readLiveImageContext).toHaveBeenCalledTimes(3);
  expect(check).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenCalledWith({org_id:org,task_id:task,channel_id:'12',state:installed},
    {plan_id:token,native_file_id:id,asset_sha256:sha},wire());
  expect(fetchImage).not.toHaveBeenCalled();
  expect(privateStore.write).not.toHaveBeenCalled();
 });
 it('does not read bytes when remote grant is absent; denies revocation after read',async()=>{
  vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED','true');
  const installed={...state,seq:'1',image:{revision:1,sha256:'c'.repeat(64)},image_intent:null,image_compatible:true};
  const current={...ctx,state:installed,media:{file_id:id,path,sha256:sha,size_bytes:jpeg.length,mime:'image/jpeg',revision:1,asset:proof.manifest[0]}};
  posts.readLiveImageContext.mockResolvedValue(current);
  check.mockResolvedValueOnce(false);
  await expect(svc.preview(org,pid,task,target,installed,wire,check)).rejects.toThrow('editorial_image_preview_unavailable');
  expect(privateStore.read).not.toHaveBeenCalled();
  check.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(svc.preview(org,pid,task,target,installed,wire,check)).rejects.toThrow('editorial_image_preview_unavailable');
  expect(privateStore.read).toHaveBeenCalledTimes(1);
  expect(privateStore.write).not.toHaveBeenCalled();
 });
 it('preview fails closed on stale state, corrupted bytes, or a changed receipt during read',async()=>{
  vi.stubEnv('EDITORIAL_TEST_LIVE_IMAGE_PREVIEW_ENABLED','true');
  const installed={...state,seq:'1',image:{revision:1,sha256:'c'.repeat(64)},image_intent:null,image_compatible:true};
  const current={...ctx,state:installed,media:{file_id:id,path,sha256:sha,size_bytes:jpeg.length,mime:'image/jpeg',revision:1,asset:proof.manifest[0]}};
  posts.readLiveImageContext.mockResolvedValue(current);
  await expect(svc.preview(org,pid,task,target,{...installed,seq:'0'},wire,check)).rejects.toThrow('editorial_image_preview_unavailable');
  expect(privateStore.read).not.toHaveBeenCalled();
  privateStore.read.mockResolvedValueOnce(Buffer.from('tampered'));
  await expect(svc.preview(org,pid,task,target,installed,wire,check)).rejects.toThrow('editorial_image_preview_unavailable');
  posts.readLiveImageContext.mockResolvedValueOnce(current).mockResolvedValueOnce({...current,state:{...installed,seq:'2'}});
  await expect(svc.preview(org,pid,task,target,installed,wire,check)).rejects.toThrow('editorial_image_preview_unavailable');
  expect(privateStore.write).not.toHaveBeenCalled();
  expect(posts.reserveLiveImageImport).not.toHaveBeenCalled();
 });
});
