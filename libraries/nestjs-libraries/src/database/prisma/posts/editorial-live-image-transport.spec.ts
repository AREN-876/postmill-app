import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { EDITORIAL_LIVE_IMAGE_LOOKUP_PATH, EDITORIAL_LIVE_IMAGE_READ_PATH,
  EditorialTransportError, fetchEditorialLiveImage, type EditorialWireConfig,
  type EditorialLiveImageRequest } from './editorial-signed-transport';

const cfg: EditorialWireConfig = {orgId:'org-modes',requestKeyHex:'a'.repeat(64),responseKeyHex:'b'.repeat(64),allowLiveImageRead:true};
// Transport fixture only, not a decodable JPEG. Native import must decode independently.
const bytes = Buffer.from('ffd8ffd9','hex');
const digest = (v: string | Buffer) => createHash('sha256').update(typeof v === 'string' ? Buffer.from(v) : v).digest('hex');
const mac = (key:string, msg:string) => createHmac('sha256', Buffer.from(key,'hex')).update(msg,'ascii').digest('hex');
// Independent fixed field ordering matching PG17 jsonb::text for this vector.
const asset = {asset_id:'12345678-1234-4234-8234-123456789abc',sha256:digest(bytes),mime:'image/jpeg',
  width:1152,height:768,size_bytes:bytes.length,provider:'fal',model:'fal-ai/flux-2/klein/9b',plan_id:'22345678-1234-4234-8234-123456789abc'};
const manifestText = pg([asset]);
const before = {binding:{task_id:'11',profile_ref:'review-ci@v3',org_id:'org-modes',integration_id:'mock-review-automatic',
  post_id:'automatic-post',group_id:'automatic-group',is_test:true},seq:'0',image_mode:'automatic',text_status:'pending',
  text_request_id:null,text:{revision:1,sha256:'c'.repeat(64)},image:null,image_compatible:false,image_intent:'initial:1',
  rejected:false,final_approved:false,dispatch_authorized:false,publishable:false};
const request: EditorialLiveImageRequest = {org_id:'org-modes',task_id:'11',channel_id:'12',state:before};
const after = {...before,seq:'1',image:{revision:1,sha256:digest(manifestText)},image_compatible:true,image_intent:null};
const ev = {schema_version:1,event_id:'live-image:'+asset.plan_id,producer:'operator',actor_id:'ci-editor',occurred_at:'2026-11-24T08:00:00Z',
  binding:before.binding,expected_seq:'0',action:'install_image',text:before.text,image:null,feedback:'',
  request_id:'initial:1',revision_content:{plan_id:asset.plan_id,plan_sha256:'e'.repeat(64),asset_sha256:asset.sha256}};
// For the event, use a test serializer driven by byte ordering (the SQL
// round-trip later tests the actual PG implementation).
function pg(v:unknown):string {
  if (v===null || typeof v!=='object') return JSON.stringify(v);
  if (Array.isArray(v)) return '['+v.map(pg).join(', ')+']';
  return '{'+Object.entries(v).sort(([a],[b])=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(([k,x])=>JSON.stringify(k)+': '+pg(x)).join(', ')+'}';
}
const proof = {channel_id:'12',install_event_id:ev.event_id,install_payload_sha256:digest(pg(ev)),install_event:ev,
  state:after,manifest:[asset],publishable:false,dispatch_authorized:false};
function peer(options?: {missing?:boolean; wrongProof?:boolean; wrongBinary?:boolean; wrongSignature?:boolean; tooLarge?:boolean}) {
  return vi.fn(async (url:string, init?:RequestInit) => {
    const path=new URL(url).pathname, raw=init?.body as string, h=init?.headers as Record<string,string>;
    expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
    expect(h['x-edx-signature']).toBe('sha256='+mac(cfg.requestKeyHex,['EDX1','REQ',path,h['x-edx-timestamp'],h['x-edx-nonce'],digest(raw)].join('\n')));
    let payload:Buffer;
    if (path===EDITORIAL_LIVE_IMAGE_LOOKUP_PATH) {
      expect(JSON.parse(raw)).toEqual({schema_version:1,...request});
      payload=Buffer.from(JSON.stringify({schema_version:1,found:!options?.missing,
        proof:options?.missing?null:options?.wrongProof?{...proof,state:{...after,text:{revision:2,sha256:'d'.repeat(64)}}}:proof}));
    } else {
      expect(path).toBe(EDITORIAL_LIVE_IMAGE_READ_PATH);
      expect(JSON.parse(raw)).toEqual({schema_version:1,...request,state:after,asset_id:asset.asset_id,asset_sha256:asset.sha256});
      payload=options?.tooLarge?Buffer.alloc(8*1024*1024+1):options?.wrongBinary?Buffer.from('tampered'):bytes;
    }
    const sig=mac(cfg.responseKeyHex,['EDX1','RESP',path,h['x-edx-timestamp'],h['x-edx-nonce'],digest(raw),digest(payload)].join('\n'));
    return new Response(new Uint8Array(payload),{status:200,headers:{'content-type':path===EDITORIAL_LIVE_IMAGE_LOOKUP_PATH?'application/json':'application/octet-stream',
      'cache-control':'no-store','x-edx-response-signature':'sha256='+(options?.wrongSignature?'0'.repeat(64):sig)}});
  });
}
describe('inactive live image export receiver',()=>{
  it('authenticates exact proof and raw image; no base64 or additional calls',async()=>{
    expect(pg([asset])).toBe(manifestText);
    const fetcher=peer();
    const result=await fetchEditorialLiveImage(request,cfg,fetcher,1795500000000);
    expect(result?.proof).toEqual(proof); expect(result?.bytes).toEqual(bytes);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('missing proof is read-only unknown',async()=>{
    const fetcher=peer({missing:true});
    expect(await fetchEditorialLiveImage(request,cfg,fetcher,1795500000000)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([{wrongProof:true},{wrongSignature:true},{wrongBinary:true},{tooLarge:true}])('rejects untrusted content: %j',async(options)=>{
    const fetcher=peer(options);
    await expect(fetchEditorialLiveImage(request,cfg,fetcher,1795500000000)).rejects.toBeInstanceOf(EditorialTransportError);
    expect(fetcher).toHaveBeenCalledTimes(options.wrongProof||options.wrongSignature?1:2);
  });
  it('rejects wrong organization or disabled transport before network',async()=>{
    const fetcher=peer();
    await expect(fetchEditorialLiveImage({...request,org_id:'other'},cfg,fetcher)).rejects.toBeInstanceOf(EditorialTransportError);
    await expect(fetchEditorialLiveImage(request,{...cfg,allowLiveImageRead:false},fetcher)).rejects.toBeInstanceOf(EditorialTransportError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
