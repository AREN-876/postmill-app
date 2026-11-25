import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { Client } from 'pg';
import { PrismaClient } from '@prisma/client';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MaxProvider } from '@postmill-ai/provider-max';
import { setSocialFetchPorts } from '@postmill-ai/provider-kernel';
import { maxStoryParts } from '@postmill-ai/provider-kernel/domains/max-story';
import { MaxOccurrences } from './max-occurrences';
import { EditorialPrivateImageStore } from './editorial-private-image';
import { makeLiveJpegFixture } from './editorial-live-jpeg.fixture';
import { qualifyPrivateReleaseHandoff } from './editorial-private-release-photo';
import { checkEditorialLivePreview, EDITORIAL_LIVE_PREVIEW_PATH, type EditorialWireConfig } from './editorial-signed-transport';

// Separate disposable migrated DB, never the db-push integration DB or a
// production database. pg_temp functions remain on one dedicated connection;
// native CAS uses an independent Prisma connection and commits before transport.
const base=new URL(inject('dbUrl'));
if(!/^\/postmill_test_[0-9]+[a-zA-Z0-9_]*$/.test(base.pathname)) throw Error('isolated integration database required');
const name='postmill_test_'+process.pid+'_edx_'+randomUUID().replaceAll('-','').slice(0,12);
const adminUrl=new URL(base);adminUrl.pathname='/postgres';
const testUrl=new URL(base);testUrl.pathname='/'+name;
const admin=new Client({connectionString:adminUrl.toString()});
const pg=new Client({connectionString:testUrl.toString()});
const db=new PrismaClient({datasources:{db:{url:testUrl.toString()}}});
const native=new MaxOccurrences(db);
const org='org-modes',target='max:-73052031470103',chat='-73052031470103';
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const mac=(key:string,msg:string)=>createHmac('sha256',Buffer.from(key,'hex')).update(msg,'ascii').digest('hex');
const cfg:EditorialWireConfig={orgId:org,requestKeyHex:'a'.repeat(64),responseKeyHex:'b'.repeat(64),allowLiveImagePreview:true,allowLiveImageReview:true};
let created=false,adminConnected=false,pgConnected=false,folder:string|undefined,bytes:Buffer;
let store:EditorialPrivateImageStore,publicationId:string,sourceId:string;

beforeAll(async()=>{
 await admin.connect();adminConnected=true;
 // name generated internally and constrained to test-only characters.
 await admin.query('CREATE DATABASE "'+name+'"');created=true;
 const schema=fileURLToPath(new URL('../schema.prisma',import.meta.url));
 execFileSync('pnpm',['exec','prisma','migrate','deploy','--schema',schema],{
  cwd:dirname(dirname(dirname(dirname(schema)))),
  env:{...process.env,DATABASE_URL:testUrl.toString()},stdio:'pipe',timeout:120000,
 });
 await pg.connect();pgConnected=true;
 expect((await pg.query('SELECT current_database() AS name')).rows[0].name).toBe(name);
 expect(Number((await pg.query('SELECT count(*) AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')).rows[0].n)).toBe(61);
 bytes=await makeLiveJpegFixture();
 // Reuse the fixture setup through immutable release; exercise installed migration 61.
 // Substitute only generated test DB allowlist + actual JPEG bytes; omit
 // synthetic occurrence/journal tail and commit the disposable fixture.
 const fixture=readFileSync(new URL('../../../../../../tools/db/editorial-live-image-full-assertions.sql',import.meta.url),'utf8');
 const stop=fixture.indexOf(' -- 028B.2A: read projection of a due initial occurrence');
 const start=fixture.indexOf('BEGIN;');
 if(start<0||stop<start)throw Error('fixture boundary missing');
 const allow="'postmill_image_ci','edx_upgrade_restored_44','postmill-editorial-restore-ci'";
 let seed=fixture.slice(start,stop);
 if(seed.split(allow).length!==3||seed.split("decode('ffd8ffd9','hex')").length!==2)throw Error('fixture identity changed');
 seed=seed.replaceAll(allow,"'"+name+"'").replace("decode('ffd8ffd9','hex')","decode('"+bytes.toString('hex')+"','hex')");
 await pg.query(seed+'\nEND $test$;\nCOMMIT;');
 await pg.query("SELECT set_config('postmill.editorial_live_release_worker_enabled','on',false)");
 const rows=await pg.query('SELECT "sourcePostId","publicationPostId" FROM "EditorialRelease"');
 expect(rows.rowCount).toBe(1);
 sourceId=rows.rows[0].sourcePostId;publicationId=rows.rows[0].publicationPostId;
 const f=await pg.query('SELECT "importId","storagePath" FROM "EditorialImageImportReceipt"');
 expect(f.rowCount).toBe(1);
 folder=await mkdtemp(join(tmpdir(),'edx-release-ci-'));
 const root=join(folder,'private'),uploads=join(folder,'uploads');
 await mkdir(root,{mode:0o700});await mkdir(uploads,{mode:0o700});
 store=await EditorialPrivateImageStore.open(root,uploads);
 expect(await store.write(f.rows[0].importId,bytes)).toBe(f.rows[0].storagePath);
 expect(await readdir(uploads)).toEqual([]);
},180000);

afterAll(async()=>{
 vi.unstubAllEnvs();
 await db.$disconnect();
 if(pgConnected)await pg.end();
 if(created&&adminConnected)await admin.query('DROP DATABASE "'+name+'" WITH (FORCE)');
 if(adminConnected)await admin.end();
 if(folder)await rm(folder,{recursive:true,force:true});
},30000);

describe('028B.3A migrated native release to real adapter (synthetic peers)',()=>{
 it('uses actual immutable release, real private JPEG, native CAS and one authenticated mocked upload/publication',async()=>{
  const source=await db.post.findUniqueOrThrow({where:{id:sourceId}});
  const pub=await db.post.findUniqueOrThrow({where:{id:publicationId},include:{integration:true}});
  const initial=await native.initial(publicationId,org);
  expect(initial.id).toMatch(/^max_[a-f0-9]{64}$/);
  await native.plan(publicationId,org,initial.id);
  const identity={orgId:org,publicationPostId:publicationId,occurrenceId:initial.id,attempt:1 as const};
  const read=async()=> (await pg.query('SELECT public.postmill_read_live_release_photo_v1($1,$2,$3) AS p',[org,publicationId,initial.id])).rows[0].p;
  const snapshot=await read();
  expect(snapshot?.media.sha256).toBe(sha(bytes));
  expect(snapshot?.fingerprint).toBe(initial.fingerprint);
  const settings=JSON.parse(pub.settings!);
  const story=maxStoryParts(pub.content,settings.continuationText);
  const storyPartsSha256=sha(JSON.stringify(story));
  // This is the actual signed client, with a synthetic peer that verifies
  // the HMAC and independently expected native snapshot/pin. No real Engine.
  const peer=vi.fn(async(url:string,init?:RequestInit)=>{
   const path=new URL(url).pathname,h=init!.headers as Record<string,string>,raw=init!.body as string;
   expect(path).toBe(EDITORIAL_LIVE_PREVIEW_PATH);
   expect(init!.method).toBe('POST');expect(init!.redirect).toBe('error');
   expect(h['x-edx-signature']).toBe('sha256='+mac(cfg.requestKeyHex,
    ['EDX1','REQ',path,h['x-edx-timestamp'],h['x-edx-nonce'],sha(raw)].join('\n')));
   expect(JSON.parse(raw)).toEqual({schema_version:1,...snapshot.request,native_pin:snapshot.pin});
   const response=JSON.stringify({schema_version:1,allowed:true});
   return new Response(response,{status:200,headers:{'content-type':'application/json','cache-control':'no-store',
    'x-edx-response-signature':'sha256='+mac(cfg.responseKeyHex,
     ['EDX1','RESP',path,h['x-edx-timestamp'],h['x-edx-nonce'],sha(raw),sha(response)].join('\n'))}});
  });
  const check:typeof checkEditorialLivePreview=(request,pin,wire)=>checkEditorialLivePreview(request,pin,wire,peer);
  const claim=vi.fn(async(_id:typeof identity,operationId:string,photoSha256:string)=>native.begin(publicationId,org,initial.id,{
   content:pub.content,integrationName:pub.integration.name,integrationId:pub.integrationId,
   chatId:target,providerConfigId:pub.integration.providerConfigId,version:pub.integration.providerVersion,
   textSha256:sha(pub.content),storygoOperationId:operationId,storyPartsSha256,storyPhotoSha256:photoSha256,
  },1));
  const readStarted=async(_id:typeof identity,operationId:string)=>{
   const j=await db.maxDeliveryAttempt.findUnique({where:{occurrenceId_number:{occurrenceId:initial.id,number:1}}});
   if((j?.target as any)?.storyPartsSha256!==storyPartsSha256)return null;
   return (await pg.query('SELECT public.postmill_read_live_release_photo_v1($1,$2,$3,true,$4) AS p',[org,publicationId,initial.id,operationId])).rows[0].p;
  };
  vi.stubEnv('STORYGO_GATEWAY_ENABLED','1');
  vi.stubEnv('STORYGO_GATEWAY_BASE_URL','https://gateway.example.invalid');
  vi.stubEnv('STORYGO_GATEWAY_SERVICE_KEY','synthetic-gateway-secret-with-32-characters');
  vi.stubEnv('STORYGO_GATEWAY_ALLOWED_CHANNELS',chat);
  const uploadId='a8db6639-7ba0-42b7-8587-dd39d630c91b';
  const gateway=vi.fn(async(url:string,init:any)=>{
   expect(init.method).toBe('POST');expect(init.redirect).toBe('error');
   const j=await db.maxDeliveryOccurrence.findUniqueOrThrow({where:{id:initial.id}});
   expect(j.state).toBe('STARTED');expect(j.attempt).toBe(1);
   const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
   if(url==='https://gateway.example.invalid/gateway/v1/media'){
    expect(init.body).toBeInstanceOf(Buffer);expect(init.body.includes(bytes)).toBe(true);
    expect(init.body.toString()).toContain('filename="story.jpg"');
    return reply({upload_id:uploadId,sha256:sha(bytes),mime_type:'image/jpeg',bytes:bytes.length},201);
   }
   expect(url).toBe('https://gateway.example.invalid/gateway/v1/publications');
   const body=JSON.parse(init.body);
   expect(body).toMatchObject({type:'story',channel_id:chat,external_post_id:publicationId,revision:initial.id,
    upload_id:uploadId,parts:story.parts});
   expect(JSON.stringify(body)).not.toContain('editorial-private:');
   expect(JSON.stringify(body)).not.toContain(bytes.toString('base64'));
   return reply({operation_id:body.operation_id,channel_id:chat,state:'PUBLISHED',message_id:'mid.synthetic-ci',error:null});
  });
  class BodyError extends Error {constructor(_a:string,_b:string,_c:unknown,message:string){super(message);}}
  setSocialFetchPorts({undiciFetch:gateway,safeFetch:gateway,ssrfSafeDispatcher:{synthetic:true},
    getVpnDispatcher:()=>undefined,isSafePublicHttpsUrl:async()=>true,BadBodyError:BodyError as any,
    RefreshTokenError:BodyError as any,timer:async()=>undefined,sharp:vi.fn(),readOrFetch:async()=>Buffer.from('')});
  const provider=new MaxProvider();
  const hold=vi.fn(async()=>{await native.fail(publicationId,org,initial.id);});
  const send=vi.fn(async(payload:any)=>{
   const result=await provider.post(target,'synthetic-max-bot-token',[{id:publicationId,message:pub.content,media:[],
     settings:{...settings,__gateway:payload}}]);
   expect(result[0]?.postId).toBe('mid.synthetic-ci');
   await native.confirm(publicationId,org,initial.id,1,result[0]);
  });
  const deps={read,open:async()=>store,wire:cfg,check,claim,readStarted,hold,send};
  expect(await qualifyPrivateReleaseHandoff(identity,deps)).toEqual({status:'handoff_returned'});
  expect(peer).toHaveBeenCalledTimes(3);
  expect(send).toHaveBeenCalledTimes(1);expect(hold).not.toHaveBeenCalled();
  expect(gateway.mock.calls.map(([url])=>url)).toEqual([
   'https://gateway.example.invalid/gateway/v1/media','https://gateway.example.invalid/gateway/v1/publications']);
  expect((await db.post.findUniqueOrThrow({where:{id:publicationId}})).state).toBe('PUBLISHED');
  expect(await db.post.findUniqueOrThrow({where:{id:sourceId}})).toEqual(source);
  expect(await db.maxDeliveryAttempt.count({where:{occurrenceId:initial.id}})).toBe(1);
  await expect(qualifyPrivateReleaseHandoff(identity,deps)).rejects.toThrow('editorial_release_photo_unavailable');
  expect(claim).toHaveBeenCalledTimes(1);expect(gateway).toHaveBeenCalledTimes(2);
 },30000);
});
