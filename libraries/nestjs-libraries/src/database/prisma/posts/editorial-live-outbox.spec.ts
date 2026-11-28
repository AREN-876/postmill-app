import { beforeEach,describe,expect,it,vi } from 'vitest';
vi.mock('./posts.repository',()=>({PostsRepository:class {}}));
vi.mock('./editorial-signed-transport',async importOriginal=>{
 const actual=await importOriginal<typeof import('./editorial-signed-transport')>();
 return {...actual,signedEditorialRequest:vi.fn(),signedEditorialLiveReviewRequest:vi.fn()};
});
import { EditorialDeliveryService } from './editorial-delivery.service';
import { signedEditorialRequest,signedEditorialLiveReviewRequest } from './editorial-signed-transport';

const org='org-modes',task='42',target='max:-73052031470103';
const scope={org_id:org,integration_id:'mock-review-automatic',campaign_id:'ci',channel_id:'1',
 profile_ref:'ci@v1',is_test:true as const,image_mode:'automatic' as const};
const eid='11111111-1111-4111-8111-111111111111';
const pin={plan_id:'22222222-2222-4222-8222-222222222222',
 native_file_id:'33333333-3333-4333-8333-333333333333',asset_sha256:'a'.repeat(64)};
const pending={schema_version:1,org_id:org,task_id:task,event_id:eid,payload_sha256:'b'.repeat(64),
 event:{schema_version:1,event_id:eid,producer:'postmill',binding:{org_id:org,task_id:task,is_test:true,
 integration_id:scope.integration_id},action:'approve_final',image:{revision:1,sha256:'c'.repeat(64)}},
 dispatch_authorized:false,publishable:false};
const raw={...pending,native_pin:pin};
const config={orgId:org,requestKeyHex:'d'.repeat(64),responseKeyHex:'e'.repeat(64),allowLiveImageReview:true,
 allowMissingRecovery:true,allowMockImageReview:true};
const posts={readPendingEditorialDelivery:vi.fn(),reserveEditorialSubmit:vi.fn(),
 reserveEditorialRecovery:vi.fn(),importEditorialDecisionResult:vi.fn()};
const service=new EditorialDeliveryService(posts as never);
const live=vi.mocked(signedEditorialLiveReviewRequest);
const mock=vi.mocked(signedEditorialRequest);
const missing={schema_version:1 as const,event_id:eid,payload_sha256:pending.payload_sha256,found:false,outcome:null};
const accepted={schema_version:1 as const,event_id:eid,payload_sha256:pending.payload_sha256,
 outcome:{status:'accepted' as const,reason:null,state:{seq:'2'},dispatch_authorized:false as const,
 publishable:false as const,newly_applied:true,replay:false}};
describe('native live outbox delivery',()=>{
 beforeEach(()=>{
  vi.resetAllMocks();
  posts.readPendingEditorialDelivery.mockResolvedValue(raw);
  posts.reserveEditorialSubmit.mockResolvedValue({event_id:eid,newly_reserved:true});
  posts.importEditorialDecisionResult.mockResolvedValue({recorded:true});
  live.mockResolvedValue(accepted);
 });
 it('uses only the live signer after committed reservation and exact reread',async()=>{
  await expect(service.deliverPending(scope,task,target,config)).resolves.toMatchObject({status:'recorded',operation:'submit'});
  expect(live).toHaveBeenCalledExactlyOnceWith(pending,pin,config,'submit',expect.any(Function));
  expect(posts.reserveEditorialSubmit.mock.invocationCallOrder[0]).toBeLessThan(live.mock.invocationCallOrder[0]);
  expect(posts.readPendingEditorialDelivery).toHaveBeenCalledTimes(2);
  expect(mock).not.toHaveBeenCalled();
  expect(posts.importEditorialDecisionResult).toHaveBeenCalledTimes(1);
 });
 it('disabled live route fails before reservation; never falls back to mock',async()=>{
  await expect(service.deliverPending(scope,task,target,{...config,allowLiveImageReview:false})).rejects.toThrow();
  expect(posts.reserveEditorialSubmit).not.toHaveBeenCalled();
  expect(live).not.toHaveBeenCalled();expect(mock).not.toHaveBeenCalled();
 });
 it('refuses changed native pin after reservation',async()=>{
  posts.readPendingEditorialDelivery.mockResolvedValueOnce(raw).mockResolvedValueOnce({
   ...raw,native_pin:{...pin,asset_sha256:'0'.repeat(64)}});
  await expect(service.deliverPending(scope,task,target,config)).rejects.toThrow();
  expect(live).not.toHaveBeenCalled();expect(mock).not.toHaveBeenCalled();
 });
 it('unknown outcome after reservation allows only lookup, even with ordinary recovery enabled',async()=>{
  live.mockRejectedValueOnce(Error('unknown'));
  await expect(service.deliverPending(scope,task,target,config)).rejects.toThrow();
  posts.reserveEditorialSubmit.mockResolvedValue({event_id:eid,newly_reserved:false});
  live.mockResolvedValueOnce(missing);
  await expect(service.deliverPending(scope,task,target,config)).resolves.toEqual({status:'unknown',operation:'lookup'});
  expect(live.mock.calls.map(x=>x[3])).toEqual(['submit','lookup']);
  expect(posts.reserveEditorialRecovery).not.toHaveBeenCalled();
  expect(posts.importEditorialDecisionResult).not.toHaveBeenCalled();
  expect(mock).not.toHaveBeenCalled();
 });
 it('reconciles by signed lookup without claiming another send',async()=>{
  live.mockResolvedValueOnce({...accepted,found:true,outcome:{...accepted.outcome,newly_applied:false,replay:true}});
  await expect(service.reconcileOnce(scope,task,target,config)).resolves.toMatchObject({status:'recorded'});
  expect(live).toHaveBeenCalledExactlyOnceWith(pending,pin,config,'lookup',expect.any(Function));
  expect(posts.reserveEditorialSubmit).not.toHaveBeenCalled();
  expect(posts.importEditorialDecisionResult).toHaveBeenCalledTimes(1);
 });
});
