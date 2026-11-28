import { beforeEach,describe,expect,it,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { makeLiveJpegFixture } from './editorial-live-jpeg.fixture';
import { prepareEditorialPrivateReleasePhoto,qualifyPrivateReleaseHandoff } from './editorial-private-release-photo';
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
    fingerprint:'e'.repeat(64),confirmed_seq:'3',target:'max:-73052031470103',publishable:false,dispatch_authorized:false,
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
 it('only a fresh native claim reaches the mock transport, with exact post-claim reads',async()=>{
  const claim=vi.fn().mockResolvedValueOnce({attempt:1,occurrenceId:occurrence}).mockResolvedValue({blocked:true});
  const readStarted=vi.fn(async()=>structuredClone(projection)),hold=vi.fn(),send=vi.fn();
  const deps={read,check,open,wire,claim,readStarted,hold,send};
  expect(await qualifyPrivateReleaseHandoff(identity,deps)).toEqual({status:'handoff_returned'});
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toMatchObject({revision:occurrence,externalPostId:publication,
    image:{sha256:projection.media.sha256,mimeType:'image/jpeg'}});
  expect(readStarted).toHaveBeenCalledTimes(2);
  expect(check).toHaveBeenCalledTimes(3);
  expect(await qualifyPrivateReleaseHandoff(identity,deps)).toEqual({status:'not_claimed'});
  expect(send).toHaveBeenCalledTimes(1);expect(hold).not.toHaveBeenCalled();
 });
 it.each(['revoked','native_changed','unknown_send'] as const)('holds after claim without retry: %s',async scenario=>{
  const claim=vi.fn().mockResolvedValueOnce({attempt:1,occurrenceId:occurrence}).mockResolvedValue({blocked:true});
  const readStarted=vi.fn(async()=>structuredClone(projection)),hold=vi.fn(),send=vi.fn();
  if(scenario==='revoked') check.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  if(scenario==='native_changed') readStarted.mockResolvedValueOnce(null);
  if(scenario==='unknown_send') send.mockRejectedValueOnce(new Error('unknown'));
  const deps={read,check,open,wire,claim,readStarted,hold,send};
  expect(await qualifyPrivateReleaseHandoff(identity,deps)).toEqual({status:'held'});
  expect(hold).toHaveBeenCalledExactlyOnceWith(identity);
  expect(send).toHaveBeenCalledTimes(scenario==='unknown_send'?1:0);
  expect(await qualifyPrivateReleaseHandoff(identity,deps)).toEqual({status:'not_claimed'});
  expect(send).toHaveBeenCalledTimes(scenario==='unknown_send'?1:0);
 });

 it.each(['allow','revoked','changed','wrong_receipt'] as const)('checks current after upload: %s',async scenario=>{
  let afterUpload=false;
  const readStarted=vi.fn(async()=>afterUpload && scenario==='changed'?null:structuredClone(projection));
  const signed=vi.fn(async()=>!(afterUpload&&scenario==='revoked'));
  const hold=vi.fn();
  const send=vi.fn(async(_payload:any,authority:any)=>{
    afterUpload=true;
    const receipt={sha256:scenario==='wrong_receipt'?'0'.repeat(64):projection.media.sha256,bytes:bytes.length,mime_type:'image/jpeg'};
    const first=await authority.beforePublication(receipt);
    expect(await authority.beforePublication(receipt)).toEqual({allowed:false});
    expect(first).toEqual({allowed:scenario==='allow'});
    if(!first.allowed)throw Error('held');
  });
  const result=await qualifyPrivateReleaseHandoff(identity,{read,open,wire,check:signed,
    claim:async()=>({attempt:1,occurrenceId:occurrence}),readStarted,hold,send});
  expect(result.status).toBe(scenario==='allow'?'handoff_returned':'held');
  expect(hold).toHaveBeenCalledTimes(scenario==='allow'?0:1);
 });

 it('does not send or synthesize a claim after lost claim response',async()=>{
  const claim=vi.fn().mockRejectedValueOnce(new Error('commit response lost')).mockResolvedValue({blocked:true});
  const readStarted=vi.fn(),hold=vi.fn(),send=vi.fn();
  const deps={read,check,open,wire,claim,readStarted,hold,send};
  await expect(qualifyPrivateReleaseHandoff(identity,deps)).rejects.toThrow('commit response lost');
  expect(await qualifyPrivateReleaseHandoff(identity,deps)).toEqual({status:'not_claimed'});
  expect(readStarted).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
 });

});
