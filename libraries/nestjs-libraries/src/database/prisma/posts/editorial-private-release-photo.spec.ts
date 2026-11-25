import { beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeLiveJpegFixture } from './editorial-live-jpeg.fixture';
import { prepareEditorialPrivateReleasePhoto } from './editorial-private-release-photo';
const id='11111111-1111-4111-8111-111111111111';
const file='22222222-2222-4222-8222-222222222222';
const plan='33333333-3333-4333-8333-333333333333';
const org='org-modes',source='a'.repeat(32),publication='b'.repeat(32);
const occurrence='max_'+'d'.repeat(64);
const identity={orgId:org,publicationPostId:publication,occurrenceId:occurrence,attempt:1 as const};
const wire={orgId:org,requestKeyHex:'a'.repeat(64),responseKeyHex:'b'.repeat(64),allowLiveImageReview:true,allowLiveImagePreview:true};
const read=vi.fn(),check=vi.fn(),open=vi.fn(),readBytes=vi.fn();
let bytes:Buffer,projection:any;
const invoke=()=>prepareEditorialPrivateReleasePhoto(identity,{read,check,open,wire});
describe('inactive private release photo preflight',()=>{
 beforeEach(async()=>{
  vi.resetAllMocks();
  bytes=await makeLiveJpegFixture();
  const sha256=createHash('sha256').update(bytes).digest('hex');
  projection={publication_post_id:publication,source_post_id:source,occurrence_id:occurrence,attempt:1,
    confirmed_seq:'3',target:'max:-73052031470103',publishable:false,dispatch_authorized:false,
    request:{org_id:org,task_id:'42',channel_id:'1',state:{seq:'3',final_approved:true,rejected:false,
      text_status:'approved',image_compatible:true,image_intent:null,text_request_id:null,
      publishable:false,dispatch_authorized:false,binding:{post_id:source,org_id:org,task_id:'42',is_test:true},
      image:{revision:1,sha256:'c'.repeat(64)}}},
    pin:{plan_id:plan,native_file_id:file,asset_sha256:sha256},
    media:{file_id:file,revision:1,path:'editorial-private:v1:'+id+'.jpg',sha256,mime:'image/jpeg',size_bytes:bytes.length,
      asset:{asset_id:id,plan_id:plan,sha256,mime:'image/jpeg',size_bytes:bytes.length,width:1152,height:768,provider:'fal',model:'fal-ai/flux-2/klein/9b'}}};
  read.mockImplementation(async()=>structuredClone(projection));check.mockResolvedValue(true);
  open.mockResolvedValue({read:readBytes});readBytes.mockImplementation(async()=>Buffer.from(bytes));
 });
 it('returns original verified JPEG in ephemeral payload, no path or dispatch grant',async()=>{
  const result=await invoke();
  expect(Buffer.from(result.image.base64,'base64')).toEqual(bytes);
  expect(result.image.sha256).toBe(projection.media.sha256);
  expect(result.dispatch_authorized).toBe(false);expect(result.publishable).toBe(false);
  expect(JSON.stringify(result)).not.toContain('editorial-private:');
  expect(read).toHaveBeenCalledTimes(3);expect(check).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenCalledWith(projection.request,projection.pin,wire);
  expect(readBytes).toHaveBeenCalledExactlyOnceWith(projection.media.path,bytes.length);
 });
 it('rejects missing or mismatched release/occurrence/final approval/pin before private IO',async()=>{
  for(const bad of [null,{...projection,occurrence_id:file},{...projection,confirmed_seq:'2'},
    {...projection,pin:{...projection.pin,native_file_id:id}},
    {...projection,request:{...projection.request,state:{...projection.request.state,final_approved:false}}},
    {...projection,media:{...projection.media,path:'/uploads/public.jpg'}}]){
    read.mockResolvedValueOnce(bad);
    await expect(invoke()).rejects.toThrow('editorial_release_photo_unavailable');
  }
  await expect(prepareEditorialPrivateReleasePhoto({...identity,occurrenceId:id},{read,check,open,wire})).rejects.toThrow();
  expect(open).not.toHaveBeenCalled();expect(check).not.toHaveBeenCalled();
 });
 it('rejects revocation before or after reading, without fallback',async()=>{
  check.mockResolvedValueOnce(false);
  await expect(invoke()).rejects.toThrow();expect(open).not.toHaveBeenCalled();
  check.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(invoke()).rejects.toThrow();expect(readBytes).toHaveBeenCalledTimes(1);
 });
 it('rejects native snapshot changes during IO or final recheck',async()=>{
  read.mockResolvedValueOnce(structuredClone(projection)).mockResolvedValueOnce({...projection,attempt:2});
  await expect(invoke()).rejects.toThrow();expect(check).toHaveBeenCalledTimes(1);
  read.mockResolvedValueOnce(structuredClone(projection)).mockResolvedValueOnce(structuredClone(projection)).mockResolvedValueOnce(null);
  await expect(invoke()).rejects.toThrow();
 });
 it('rejects corrupt bytes even with a matching digest and marker-only JPEG',async()=>{
  readBytes.mockResolvedValueOnce(Buffer.alloc(bytes.length));
  await expect(invoke()).rejects.toThrow();
  bytes=Buffer.from('ffd8ffd9','hex');
  const digest=createHash('sha256').update(bytes).digest('hex');
  projection.media.sha256=digest;projection.pin.asset_sha256=digest;
  projection.media.asset.sha256=digest;projection.media.size_bytes=bytes.length;projection.media.asset.size_bytes=bytes.length;
  await expect(invoke()).rejects.toThrow();
 });
});
