-- 60: live JPEG import using shared immutable image ledger; no release or public API.
BEGIN;
CREATE FUNCTION postmill_live_image_context_v1(org text,pid text,task text,target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s jsonb; verified jsonb; review jsonb; state jsonb; media jsonb;
BEGIN
 IF org IS DISTINCT FROM 'org-modes' OR target IS DISTINCT FROM 'max:-73052031470103'
 OR (pid ~ '^[0-9a-f]{32}$') IS NOT TRUE THEN RETURN NULL; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,task)::text,0));
 SELECT r.request->'scope' INTO s FROM "EditorialDraftReceipt" r JOIN "Post" p ON p.id=r."postId"
 WHERE p.id=pid AND p."organizationId"=org AND p."editorialTaskId"=task;
 IF NOT FOUND OR (s->'is_test'='true'::jsonb AND s->>'org_id'=org
  AND s->>'integration_id' LIKE 'mock-review-%' AND s->>'image_mode' IN ('automatic','manual','after_text_approval')) IS NOT TRUE
 THEN RETURN NULL; END IF;
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL OR verified->'receipt'->'binding'->>'post_id' IS DISTINCT FROM pid THEN RETURN NULL; END IF;
 review:=postmill_editorial_confirmed_v1(pid); state:=review->'last_confirmed_state';
 IF state IS NULL OR state->'binding' IS DISTINCT FROM verified->'receipt'->'binding'
  OR state->'text' IS DISTINCT FROM verified->'receipt'->'text' THEN RETURN NULL; END IF;
 IF jsonb_typeof(state->'image')='object' THEN
  SELECT jsonb_build_object('file_id',f.id,'path',f.path,'sha256',b."assetSha256",
    'revision',a.revision,'size_bytes',f."fileSize",'mime','image/jpeg')
  INTO media FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
   JOIN "File" f ON f.id=b."fileId"
  WHERE a."postId"=pid AND a.proof->'state'->'image'=state->'image'
   AND f."organizationId"=org AND f."deletedAt" IS NULL AND f."folderId" IS NULL
   AND f.path=b."storagePath" AND f."fileSize"=(a.proof->'manifest'->0->>'size_bytes')::int
   AND b."assetSha256"=a.proof->'manifest'->0->>'sha256'
   AND f.metadata->>'internal'='editorial-live'
   AND f.metadata->>'mimeType'='image/jpeg' AND f.metadata->>'sha256'=b."assetSha256"
   AND a.proof->'manifest'->0->>'mime'='image/jpeg'
   AND f.metadata->'dimensions'=jsonb_build_object('width',a.proof->'manifest'->0->'width','height',a.proof->'manifest'->0->'height');
  IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_MEDIA_MISMATCH' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN jsonb_build_object('scope',s,'state',state,'status',review->>'status','media',media,
 'publishable',false,'dispatch_authorized',false);
END $fn$;

-- Validate the exact next state independently of the authenticated TS receiver.
CREATE FUNCTION postmill_live_image_validate_v1(ctx jsonb,p jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE before_state jsonb:=ctx->'state'; ev jsonb:=p->'install_event'; a jsonb:=p->'manifest'->0;
 next_state jsonb; rev integer; seq bigint;
BEGIN
 IF (ctx->>'status' IN ('idle','image_import_uncertain')
 AND before_state->'rejected'='false'::jsonb AND before_state->'final_approved'='false'::jsonb
 AND before_state->>'text_status' IN ('pending','approved')
 AND (before_state->>'image_mode'<>'after_text_approval' OR before_state->>'text_status'='approved')
 AND before_state->'image_compatible'='false'::jsonb AND jsonb_typeof(before_state->'image_intent')='string'
 AND jsonb_typeof(p)='object' AND octet_length(p::text)<=32768
 AND p ?& ARRAY['channel_id','install_event_id','install_payload_sha256','install_event','state','manifest','publishable','dispatch_authorized']
 AND p-ARRAY['channel_id','install_event_id','install_payload_sha256','install_event','state','manifest','publishable','dispatch_authorized']='{}'::jsonb
 AND p->'publishable'='false'::jsonb AND p->'dispatch_authorized'='false'::jsonb
 AND p->'channel_id'=ctx->'scope'->'channel_id'
 AND jsonb_typeof(p->'manifest')='array' AND jsonb_array_length(p->'manifest')=1
 AND jsonb_typeof(a)='object' AND a ?& ARRAY['asset_id','sha256','mime','width','height','size_bytes','provider','model','plan_id']
 AND a-ARRAY['asset_id','sha256','mime','width','height','size_bytes','provider','model','plan_id']='{}'::jsonb
 AND a->>'asset_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND a->>'plan_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND a->>'sha256' ~ '^[0-9a-f]{64}$' AND a->>'mime'='image/jpeg'
 AND jsonb_typeof(a->'size_bytes')='number' AND a->>'size_bytes' ~ '^[1-9][0-9]{0,6}$'
 AND (a->>'size_bytes')::int BETWEEN 4 AND 8388608
 AND ((a->>'provider'='openai' AND a->>'model'='gpt-image-2.6-flare' AND a->'width'='1536'::jsonb AND a->'height'='1024'::jsonb)
 OR (a->>'provider'='fal' AND a->>'model' IN ('fal-ai/flux-2/klein/9b','fal-ai/flux/schnell') AND a->'width'='1152'::jsonb AND a->'height'='768'::jsonb))
 AND jsonb_typeof(ev)='object' AND ev ?& ARRAY['schema_version','event_id','producer','actor_id','occurred_at','binding','expected_seq','action','text','image','feedback','request_id','revision_content']
 AND ev-ARRAY['schema_version','event_id','producer','actor_id','occurred_at','binding','expected_seq','action','text','image','feedback','request_id','revision_content']='{}'::jsonb
 AND ev->'schema_version'='1'::jsonb AND ev->>'producer'='operator' AND ev->>'action'='install_image'
 AND ev->>'event_id'=p->>'install_event_id' AND length(ev->>'event_id') BETWEEN 1 AND 200
 AND length(ev->>'actor_id') BETWEEN 1 AND 200
 AND ev->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
 AND ev->'binding'=before_state->'binding' AND ev->'expected_seq'=before_state->'seq'
 AND ev->'text'=before_state->'text' AND ev->'image'=before_state->'image'
 AND ev->>'feedback'='' AND ev->'request_id'=before_state->'image_intent'
 AND ev->>'event_id'='live-image:'||(a->>'plan_id')
 AND jsonb_typeof(ev->'revision_content')='object'
 AND ev->'revision_content' ?& ARRAY['plan_id','plan_sha256','asset_sha256']
 AND ev->'revision_content'-ARRAY['plan_id','plan_sha256','asset_sha256']='{}'::jsonb
 AND ev->'revision_content'->'plan_id'=a->'plan_id'
 AND ev->'revision_content'->'asset_sha256'=a->'sha256'
 AND ev->'revision_content'->>'plan_sha256' ~ '^[0-9a-f]{64}$'
 AND p->>'install_payload_sha256'=encode(sha256(convert_to(ev::text,'UTF8')),'hex')) IS NOT TRUE
 THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_PROOF_INVALID' USING ERRCODE='22023'; END IF;
 seq:=(before_state->>'seq')::bigint; rev:=coalesce((before_state->'image'->>'revision')::int,0);
 IF seq=9223372036854775807 OR rev=2147483647 THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_LIMIT' USING ERRCODE='55000'; END IF;
 rev:=rev+1;
 next_state:=before_state||jsonb_build_object('seq',(seq+1)::text,'image',jsonb_build_object(
  'revision',rev,'sha256',encode(sha256(convert_to((p->'manifest')::text,'UTF8')),'hex')),
  'image_compatible',true,'image_intent',NULL,'final_approved',false);
 IF p->'state' IS DISTINCT FROM next_state THEN
  RAISE EXCEPTION 'EDITORIAL_IMAGE_PROOF_STATE_MISMATCH' USING ERRCODE='55000'; END IF;
 RETURN rev;
END $fn$;

CREATE FUNCTION postmill_reserve_live_image_import_v1(org text,pid text,task text,target text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE ctx jsonb; prior "EditorialImageImport"%ROWTYPE; rev integer; iid text; tok text; fid text;
BEGIN
 ctx:=postmill_live_image_context_v1(org,pid,task,target);
 IF ctx IS NULL THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_SCOPE' USING ERRCODE='55000'; END IF;
 SELECT * INTO prior FROM "EditorialImageImport" WHERE "postId"=pid AND "installEventId"=p->>'install_event_id';
 IF FOUND THEN
  IF prior.proof IS DISTINCT FROM p THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_PROOF_CONFLICT' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('status',CASE WHEN EXISTS(SELECT 1 FROM "EditorialImageImportReceipt" WHERE "importId"=prior.id)
    THEN 'recorded' ELSE 'uncertain' END,'publishable',false,'dispatch_authorized',false);
 END IF;
 IF ctx->>'status'<>'idle' THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_UNRESOLVED' USING ERRCODE='55000'; END IF;
 rev:=postmill_live_image_validate_v1(ctx,p);
 iid:=gen_random_uuid()::text; tok:=gen_random_uuid()::text; fid:=gen_random_uuid()::text;
 INSERT INTO "EditorialImageImport"(id,"postId",revision,"installEventId",proof,"proofHash","beforeState",token,"fileId")
 VALUES(iid,pid,rev,p->>'install_event_id',p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),ctx->'state',tok,fid);
 RETURN jsonb_build_object('status','reserved','import_id',iid,'token',tok,'publishable',false,'dispatch_authorized',false);
END $fn$;

-- The trusted adapter must have written and read back the exact bytes before
-- calling this function. A crash after reservation remains uncertain, never
-- automatically re-writes or deletes storage. No binary data in SQL logs.
CREATE FUNCTION postmill_finish_live_image_import_v1(org text,pid text,task text,target text,iid text,tok text,
 storage_path text,actual_sha text,actual_size int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE ctx jsonb; imp "EditorialImageImport"%ROWTYPE; prior "EditorialImageImportReceipt"%ROWTYPE; a jsonb; rev integer;
BEGIN
 ctx:=postmill_live_image_context_v1(org,pid,task,target);
 IF ctx IS NULL THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_SCOPE' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT imp FROM "EditorialImageImport" WHERE id=iid AND "postId"=pid;
 a:=imp.proof->'manifest'->0;
 IF a->>'mime' IS DISTINCT FROM 'image/jpeg' OR tok IS DISTINCT FROM imp.token OR actual_sha IS DISTINCT FROM a->>'sha256'
  OR actual_size IS DISTINCT FROM (a->>'size_bytes')::int
  OR storage_path IS NULL OR length(storage_path)>2048
  OR storage_path !~ '^((https?://[^/?#[:space:]]+)?/uploads/org-modes/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{32}[.]jpg)$'
 THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_STORAGE_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO prior FROM "EditorialImageImportReceipt" WHERE "importId"=iid;
 IF FOUND THEN
  IF prior."storagePath" IS DISTINCT FROM storage_path THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_STORAGE_CONFLICT' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('status','recorded','file_id',prior."fileId",'publishable',false,'dispatch_authorized',false);
 END IF;
 IF ctx->>'status'<>'image_import_uncertain' OR ctx->'state' IS DISTINCT FROM imp."beforeState"
 THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_STALE' USING ERRCODE='55000'; END IF;
 rev:=postmill_live_image_validate_v1(ctx,imp.proof);
 IF rev<>imp.revision THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_STALE' USING ERRCODE='55000'; END IF;
 INSERT INTO "File"(id,name,"originalName",path,"organizationId","fileSize",type,metadata,"updatedAt")
 VALUES(imp."fileId",'editorial-live-'||imp.revision||'.jpg','editorial-live.jpg',storage_path,org,actual_size,'image',
 jsonb_build_object('internal','editorial-live','source','editorial','mimeType','image/jpeg','sha256',actual_sha,
 'dimensions',jsonb_build_object('width',a->'width','height',a->'height')),now());
 INSERT INTO "EditorialImageImportReceipt"("importId","fileId","storagePath","assetSha256")
 VALUES(iid,imp."fileId",storage_path,actual_sha);
 IF postmill_editorial_confirmed_v1(pid)->'last_confirmed_state' IS DISTINCT FROM imp.proof->'state' THEN
  RAISE EXCEPTION 'EDITORIAL_IMAGE_NATIVE_MISMATCH' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('status','recorded','file_id',imp."fileId",'publishable',false,'dispatch_authorized',false);
END $fn$;
REVOKE ALL ON FUNCTION postmill_live_image_context_v1(text,text,text,text),
 postmill_live_image_validate_v1(jsonb,jsonb),postmill_reserve_live_image_import_v1(text,text,text,text,jsonb),
 postmill_finish_live_image_import_v1(text,text,text,text,text,text,text,text,int) FROM PUBLIC;
COMMIT;
