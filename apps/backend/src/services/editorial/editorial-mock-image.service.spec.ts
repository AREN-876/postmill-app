import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { Readable } from 'node:stream';
import { EditorialMockImageService, mockImageImportEnabled } from './editorial-mock-image.service';
import { createHash } from 'node:crypto';
import type { fetchEditorialMockImage } from '@postmill-ai/nestjs-libraries/database/prisma/posts/editorial-signed-transport';

const org='org-modes',pid='a'.repeat(32),task='42',target='max:-73052031470103';
const id='11111111-1111-4111-8111-111111111111';
const token='22222222-2222-4222-8222-222222222222';
const path='/uploads/org-modes/2026/11/24/'+'a'.repeat(32)+'.png';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg==','base64');
const sha=createHash('sha256').update(png).digest('hex');
const state={seq:'0',rejected:false,final_approved:false,image_compatible:false,image_intent:'initial:1',image_mode:'automatic',text_status:'pending'};
const ctx={scope:{org_id:org,channel_id:'12'},state,status:'idle',media:null};
const flags={publishable:false,dispatch_authorized:false};
const posts={readMockImageContext:vi.fn(),reserveMockImageImport:vi.fn(),finishMockImageImport:vi.fn()};
const adapter={type:'LOCAL',writeBuffer:vi.fn(),readFileStream:vi.fn(),removeFile:vi.fn()};
const storage={getBaseAdapterForOrg:vi.fn(),assertWithinProviderQuota:vi.fn()};
const fetchImage=vi.fn();
const proof={fixture:'proof'};
const wire=()=>({orgId:org,requestKeyHex:'a'.repeat(64),responseKeyHex:'b'.repeat(64)});
const svc=new EditorialMockImageService(posts as never,storage as never);
const call=()=>svc.import(org,pid,task,target,'0',wire,fetchImage as typeof fetchEditorialMockImage);

describe('native fixture image import',()=>{
 beforeEach(()=>{
  vi.resetAllMocks();
  vi.stubEnv('EDITORIAL_TEST_SESSION_ENABLED','true');vi.stubEnv('EDITORIAL_TEST_ORG_ID',org);
  vi.stubEnv('EDITORIAL_TEST_MAX_TARGET',target);vi.stubEnv('EDITORIAL_TEST_MOCK_IMAGE_IMPORT_ENABLED','true');
  posts.readMockImageContext.mockResolvedValue(ctx);
  posts.reserveMockImageImport.mockResolvedValue({status:'reserved',import_id:id,token,...flags});
  posts.finishMockImageImport.mockResolvedValue({status:'recorded',file_id:id,...flags});
  storage.getBaseAdapterForOrg.mockResolvedValue(adapter);
  storage.assertWithinProviderQuota.mockResolvedValue(undefined);
  adapter.writeBuffer.mockResolvedValue(path);
  adapter.readFileStream.mockImplementation(async()=>Readable.from([png]));
  fetchImage.mockResolvedValue({proof,bytes:png});
 });
 afterEach(()=>vi.unstubAllEnvs());
 it('requires dedicated opt-in and exact disposable scope',async()=>{
  expect(mockImageImportEnabled(org,target)).toBe(true);
  expect(mockImageImportEnabled('other',target)).toBe(false);
  vi.stubEnv('EDITORIAL_TEST_MOCK_IMAGE_IMPORT_ENABLED','false');
  await expect(call()).rejects.toThrow('editorial_image_import_disabled');
  expect(posts.readMockImageContext).not.toHaveBeenCalled();
 });
 it('commits reservation before write, verifies native bytes before receipt',async()=>{
  expect(await call()).toEqual({status:'recorded',...flags});
  expect(posts.reserveMockImageImport).toHaveBeenCalledWith(org,pid,task,target,proof);
  expect(adapter.writeBuffer).toHaveBeenCalledExactlyOnceWith(png,'image/png');
  expect(posts.reserveMockImageImport.mock.invocationCallOrder[0]).toBeLessThan(adapter.writeBuffer.mock.invocationCallOrder[0]);
  expect(adapter.readFileStream.mock.invocationCallOrder[0]).toBeLessThan(posts.finishMockImageImport.mock.invocationCallOrder[0]);
  expect(posts.finishMockImageImport).toHaveBeenCalledWith(org,pid,task,target,id,token,path,sha,png.length);
 });
 it('never writes on not-ready or unresolved reservation',async()=>{
  fetchImage.mockResolvedValueOnce(null);
  expect(await call()).toEqual({status:'not_ready',...flags});
  posts.reserveMockImageImport.mockResolvedValueOnce({status:'uncertain',...flags});
  expect(await call()).toEqual({status:'uncertain',...flags});
  expect(adapter.writeBuffer).not.toHaveBeenCalled();
  expect(posts.finishMockImageImport).not.toHaveBeenCalled();
 });
 it('does not remove or repeat writes after native storage or SQL failure',async()=>{
  adapter.readFileStream.mockResolvedValueOnce(Readable.from([Buffer.from('tampered')]));
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.finishMockImageImport).not.toHaveBeenCalled();
  posts.readMockImageContext.mockResolvedValueOnce({...ctx,status:'image_import_uncertain'});
  expect(await call()).toEqual({status:'uncertain',...flags});
  expect(adapter.writeBuffer).toHaveBeenCalledTimes(1);
  expect(adapter.removeFile).not.toHaveBeenCalled();
 });
 it('does not reserve with an unsupported adapter or quota rejection',async()=>{
  storage.getBaseAdapterForOrg.mockResolvedValueOnce({...adapter,type:'S3'});
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  storage.assertWithinProviderQuota.mockRejectedValueOnce(Error('quota'));
  await expect(call()).rejects.toThrow('editorial_image_import_outcome_unknown');
  expect(posts.reserveMockImageImport).not.toHaveBeenCalled();
  expect(adapter.writeBuffer).not.toHaveBeenCalled();
 });
 it('preview is sourced from native bytes, not an exposed storage path',async()=>{
  const current={...state,seq:'1',image_compatible:true,image_intent:null,image:{revision:1,sha256:'f'.repeat(64)}};
  posts.readMockImageContext.mockResolvedValueOnce({...ctx,state:current,media:{file_id:id,path,sha256:sha,size_bytes:png.length,mime:'image/png',revision:1}});
  const out=await svc.preview(org,pid,task,target,current);
  expect(out).toEqual({status:'recorded',can_import:false,asset:{file_id:id,revision:1,sha256:sha,compatible:true,png_base64:png.toString('base64')}});
  expect(JSON.stringify(out)).not.toContain(path);
 });
});
