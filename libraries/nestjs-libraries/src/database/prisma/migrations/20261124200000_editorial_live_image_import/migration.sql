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
    'revision',a.revision,'size_bytes',f."fileSize",'mime','image/jpeg','asset',a.proof->'manifest'->0)
  INTO media FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
   JOIN "File" f ON f.id=b."fileId"
  WHERE a."postId"=pid AND a.proof->'state'->'image'=state->'image'
   AND f."organizationId"=org AND f."deletedAt" IS NULL AND f."folderId" IS NULL
   AND f.path=b."storagePath" AND f.path='editorial-private:v1:'||a.id||'.jpg' AND f."fileSize"=(a.proof->'manifest'->0->>'size_bytes')::int
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
 AND (ev->'revision_content')-ARRAY['plan_id','plan_sha256','asset_sha256']='{}'::jsonb
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
  OR storage_path IS DISTINCT FROM 'editorial-private:v1:'||imp.id||'.jpg'
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

-- Native route derives the pin from the immutable image import and File receipt,
-- never an HTTP-supplied path, provider, plan, or File ID. The immutable event
-- image revision+manifest hash is the durable pin reference; no second queue.
CREATE FUNCTION postmill_live_image_pin_v1(pid text, image_ref jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT jsonb_build_object('plan_id',a.proof->'manifest'->0->>'plan_id',
   'native_file_id',b."fileId",'asset_sha256',b."assetSha256")
 FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
 JOIN "File" f ON f.id=b."fileId" JOIN "Post" p ON p.id=a."postId"
 WHERE a."postId"=pid AND jsonb_typeof(image_ref)='object' AND a.proof->'state'->'image'=image_ref
 AND a.proof->'manifest'->0->>'mime'='image/jpeg' AND f.metadata->>'internal'='editorial-live'
 AND f."organizationId"=p."organizationId" AND f."deletedAt" IS NULL AND f."folderId" IS NULL
 AND f.path=b."storagePath" AND f.path='editorial-private:v1:'||a.id||'.jpg'
 AND b."assetSha256"=a.proof->'manifest'->0->>'sha256'
 AND f.metadata->>'sha256'=b."assetSha256"
$fn$;

CREATE FUNCTION postmill_queue_editorial_decision_internal_v2(s jsonb, task text, target text, actor text, command jsonb, live boolean) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; anchor jsonb; pid text; action text; feedback text; cmd text;
 old "EditorialDecisionOutbox"%ROWTYPE; ev jsonb; eid text; h text; created boolean:=false; confirmed jsonb; remote_status text:='unconfirmed'; ctx jsonb;
BEGIN
 IF (live IS NOT NULL AND actor IS NOT NULL AND actor ~ '^[A-Za-z0-9_.:-]{1,200}$'
  AND jsonb_typeof(command)='object' AND octet_length(command::text)<=30000
  AND command ?& ARRAY['command_id','expected_seq','action','text','image','feedback']
  AND command-ARRAY['command_id','expected_seq','action','text','image','feedback']='{}'::jsonb
  AND jsonb_typeof(command->'command_id')='string'
  AND command->>'command_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND jsonb_typeof(command->'expected_seq')='string'
  AND jsonb_typeof(command->'action')='string'
  AND jsonb_typeof(command->'feedback')='string'
  AND length(command->>'feedback')<=4000
  AND octet_length(command->>'feedback')<=16000
  AND jsonb_typeof(command->'text')='object'
  AND (jsonb_typeof(command->'image') IN ('null','object'))) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_DECISION' USING ERRCODE='22023'; END IF;
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL THEN RAISE EXCEPTION 'EDITORIAL_DRAFT_NOT_FOUND' USING ERRCODE='55000'; END IF;
 pid:=verified->'receipt'->'binding'->>'post_id';
 SELECT snapshot INTO anchor FROM "EditorialReviewAnchor" WHERE "postId"=pid;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_REVIEW_NOT_ACKNOWLEDGED' USING ERRCODE='55000'; END IF;
 -- A replay is historical only, returns the original envelope and never
 -- grants a second dispatch, approval, or proof of remote acceptance.
 cmd:=command->>'command_id'; action:=command->>'action'; feedback:=command->>'feedback';
 SELECT * INTO old FROM "EditorialDecisionOutbox" WHERE "postId"=pid AND "commandId"=cmd;
 IF FOUND THEN
  IF (postmill_live_image_pin_v1(pid,old.payload->'image') IS NOT NULL) IS DISTINCT FROM live THEN
   RAISE EXCEPTION 'EDITORIAL_LIVE_DECISION_ROUTE_MISMATCH' USING ERRCODE='55000'; END IF;
  IF old.payload->>'actor_id' IS DISTINCT FROM actor OR
     old.payload->>'action' IS DISTINCT FROM action OR
     old.payload->>'feedback' IS DISTINCT FROM feedback OR
     old.payload->'expected_seq' IS DISTINCT FROM command->'expected_seq' OR
     old.payload->'text' IS DISTINCT FROM command->'text' OR
     old.payload->'image' IS DISTINCT FROM command->'image' THEN
   RAISE EXCEPTION 'EDITORIAL_COMMAND_ID_CONFLICT' USING ERRCODE='55000'; END IF;
  ev:=old.payload; h:=old."payloadHash";
  SELECT outcome->>'status' INTO remote_status FROM "EditorialDecisionResult" WHERE "eventId"=old."eventId";
  remote_status:=coalesce(remote_status,'unconfirmed');
 ELSE
  confirmed:=postmill_editorial_confirmed_v1(pid);
  IF confirmed->>'status'='image_import_uncertain' THEN
   RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_UNRESOLVED' USING ERRCODE='55000'; END IF;
  IF confirmed->>'status'='pending' THEN
   RAISE EXCEPTION 'EDITORIAL_DECISION_AWAITING_RECONCILIATION' USING ERRCODE='55000'; END IF;
  IF confirmed->>'status'='rejected' THEN
   RAISE EXCEPTION 'EDITORIAL_DECISION_RECONCILIATION_REQUIRED' USING ERRCODE='55000'; END IF;
  anchor:=confirmed->'last_confirmed_state';
  IF (anchor->>'image_mode'='disabled' OR postmill_mock_image_review_scope_v1(s,target)) AND anchor->>'text_status'='changes_requested' THEN
   RAISE EXCEPTION 'EDITORIAL_REVISION_AWAITING_IMPORT' USING ERRCODE='55000'; END IF;
  IF command->'expected_seq' IS DISTINCT FROM anchor->'seq'
    OR command->'text' IS DISTINCT FROM anchor->'text'
    OR command->'image' IS DISTINCT FROM anchor->'image'
    OR anchor->'binding' IS DISTINCT FROM verified->'receipt'->'binding'
    OR anchor->'text' IS DISTINCT FROM verified->'receipt'->'text' THEN
   RAISE EXCEPTION 'EDITORIAL_STALE_DECISION' USING ERRCODE='55000'; END IF;
  -- Image-specific commands and image-bearing decisions are confined to
  -- the disposable mock target. Validate native metadata before queueing.
  IF action NOT IN ('approve_text','request_text_changes','reject','request_image','request_image_changes','confirm_image_reuse','approve_final')
    OR ((action IN ('request_image_changes','confirm_image_reuse','approve_final') OR anchor->'image'<>'null'::jsonb)
      AND NOT postmill_mock_image_review_scope_v1(s,target)) THEN
   RAISE EXCEPTION 'EDITORIAL_ACTION_BLOCKED' USING ERRCODE='55000'; END IF;
  IF live THEN
   ctx:=postmill_live_image_context_v1(s->>'org_id',pid,task,target);
   IF ctx IS NULL OR ctx->>'status' IS DISTINCT FROM 'idle'
     OR ctx->'state' IS DISTINCT FROM anchor OR postmill_live_image_pin_v1(pid,anchor->'image') IS NULL
   THEN RAISE EXCEPTION 'EDITORIAL_LIVE_DECISION_SCOPE' USING ERRCODE='55000'; END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
      WHERE a."postId"=pid AND a.proof->'manifest'->0->>'mime'='image/jpeg')
   THEN RAISE EXCEPTION 'EDITORIAL_LIVE_DECISION_ROUTE_MISMATCH' USING ERRCODE='55000'; END IF;
   IF anchor->'image'<>'null'::jsonb AND
     jsonb_typeof(postmill_mock_image_context_v1(s->>'org_id',pid,task,target)->'media') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_MEDIA_MISMATCH' USING ERRCODE='55000'; END IF;
  END IF;
  IF (action IN ('request_text_changes','request_image_changes') AND feedback !~ '[^[:space:]]')
    OR (action NOT IN ('request_text_changes','request_image_changes') AND feedback<>'') THEN
   RAISE EXCEPTION 'EDITORIAL_FEEDBACK_INVALID' USING ERRCODE='22023'; END IF;
  eid:=gen_random_uuid()::text;
  ev:=jsonb_build_object('schema_version',1,'event_id',eid,'producer','postmill','actor_id',actor,
    'occurred_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'binding',anchor->'binding','expected_seq',anchor->'seq','action',action,
    'text',anchor->'text','image',anchor->'image','feedback',feedback,
    'request_id',NULL,'revision_content',NULL);
  IF postmill_editorial_next_state_v1(anchor,ev) IS NULL THEN
   RAISE EXCEPTION 'EDITORIAL_ACTION_BLOCKED' USING ERRCODE='55000'; END IF;
  h:=encode(sha256(convert_to(ev::text,'UTF8')),'hex');
  INSERT INTO "EditorialDecisionOutbox"("eventId","postId","commandId","expectedSeq",payload,"payloadHash")
   VALUES(eid,pid,cmd,anchor->>'seq',ev,h);
  created:=true;
 END IF;
 RETURN jsonb_build_object('newly_queued',created,'replay',NOT created,'event',ev,'payload_sha256',h,
  'remote_status',remote_status,'dispatch_authorized',false,'publishable',false);
END $fn$;


CREATE OR REPLACE FUNCTION postmill_queue_editorial_decision_v1(s jsonb, task text, target text, actor text, command jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT public.postmill_queue_editorial_decision_internal_v2(s,task,target,actor,command,false)
$fn$;

CREATE FUNCTION postmill_queue_editorial_live_human_v1(
 org text, pid text, task text, target text, actor text, cmd jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE view_state jsonb; state jsonb; prior "EditorialDecisionOutbox"%ROWTYPE;
 payload jsonb; result jsonb; t jsonb; im jsonb;
BEGIN
 IF (actor IS NOT NULL AND actor ~ '^[A-Za-z0-9_.:-]{1,200}$'
  AND jsonb_typeof(cmd)='object' AND octet_length(cmd::text)<=18000
  AND cmd ?& ARRAY['command_id','expected_seq','action','feedback']
  AND cmd-ARRAY['command_id','expected_seq','action','feedback']='{}'::jsonb
  AND jsonb_typeof(cmd->'command_id')='string'
  AND cmd->>'command_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND jsonb_typeof(cmd->'expected_seq')='string'
  AND cmd->>'expected_seq' ~ '^(0|[1-9][0-9]{0,18})$'
  AND (length(cmd->>'expected_seq')<19 OR cmd->>'expected_seq'<='9223372036854775807')
  AND cmd->>'action' IN ('approve_text','request_text_changes','reject','request_image','request_image_changes','confirm_image_reuse','approve_final')
  AND jsonb_typeof(cmd->'feedback')='string'
  AND length(cmd->>'feedback')<=4000 AND octet_length(cmd->>'feedback')<=16000
  AND ((cmd->>'action' IN ('request_text_changes','request_image_changes') AND cmd->>'feedback' ~ '[^[:space:]]')
    OR (cmd->>'action' NOT IN ('request_text_changes','request_image_changes') AND cmd->>'feedback'=''))) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_INVALID_COMMAND' USING ERRCODE='22023';
 END IF;
 view_state:=postmill_read_editorial_human_v1(org,pid,task,target);
 IF view_state IS NULL THEN RETURN NULL; END IF;
 IF view_state->'review_acknowledged' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'EDITORIAL_REVIEW_NOT_ACKNOWLEDGED' USING ERRCODE='55000';
 END IF;
 -- Duplicate command IDs must remain replayable without altering hashes.
 SELECT * INTO prior FROM "EditorialDecisionOutbox" o
 WHERE o."postId"=pid AND o."commandId"=cmd->>'command_id';
 IF FOUND THEN
  t:=prior.payload->'text'; im:=prior.payload->'image';
 ELSE
  state:=view_state->'review'->'last_confirmed_state';
  t:=state->'text'; im:=state->'image';
 END IF;
 payload:=jsonb_build_object('command_id',cmd->>'command_id',
  'expected_seq',cmd->>'expected_seq','action',cmd->>'action',
  'feedback',cmd->>'feedback','text',t,'image',im);
 result:=postmill_queue_editorial_decision_internal_v2(
  (SELECT r.request->'scope' FROM "EditorialDraftReceipt" r WHERE r."postId"=pid),
  task,target,actor,payload,true);
 -- Never surface an unverified remote outcome as human approval.
 RETURN jsonb_build_object('status','queued/unconfirmed',
  'event_id',result->'event'->>'event_id',
  'newly_queued',result->'newly_queued','replay',result->'replay',
  'dispatch_authorized',false,'publishable',false);
END $fn$;

CREATE OR REPLACE FUNCTION postmill_read_editorial_delivery_v1(s jsonb, task text, target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE review jsonb; row_event "EditorialDecisionOutbox"%ROWTYPE;
 pid text; pin jsonb; ctx jsonb; envelope jsonb;
BEGIN
 review:=postmill_read_editorial_review_v1(s,task,target);
 IF review IS NULL THEN RETURN NULL; END IF;
 IF review->'review'->>'status' IS DISTINCT FROM 'pending' THEN RETURN NULL; END IF;
 pid:=review->'receipt'->'binding'->>'post_id';
 SELECT o.* INTO row_event FROM "EditorialDecisionOutbox" o
 LEFT JOIN "EditorialDecisionResult" d ON d."eventId"=o."eventId"
 WHERE o."postId"=pid AND d."eventId" IS NULL
 ORDER BY o."expectedSeq"::bigint DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_DELIVERY_INCONSISTENT' USING ERRCODE='55000'; END IF;
 IF row_event."eventId" IS DISTINCT FROM review->'review'->>'latest_event_id'
  OR row_event.payload->'binding' IS DISTINCT FROM review->'review'->'last_confirmed_state'->'binding'
  OR row_event.payload->>'expected_seq' IS DISTINCT FROM review->'review'->'last_confirmed_state'->>'seq'
  OR row_event.payload->'text' IS DISTINCT FROM review->'review'->'last_confirmed_state'->'text'
  OR row_event.payload->'image' IS DISTINCT FROM review->'review'->'last_confirmed_state'->'image'
  OR row_event.payload->>'producer' IS DISTINCT FROM 'postmill'
  OR row_event.payload->>'event_id' IS DISTINCT FROM row_event."eventId"
  OR row_event.payload->'binding'->>'task_id' IS DISTINCT FROM task
  OR row_event.payload->'binding'->>'org_id' IS DISTINCT FROM s->>'org_id'
  OR row_event.payload->'binding'->'is_test' IS DISTINCT FROM 'true'::jsonb
  OR row_event."payloadHash" IS DISTINCT FROM
     encode(sha256(convert_to(row_event.payload::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'EDITORIAL_DELIVERY_INCONSISTENT' USING ERRCODE='55000';
 END IF;
 envelope:=jsonb_build_object('schema_version',1,'org_id',s->>'org_id','task_id',task,
   'event_id',row_event."eventId",'payload_sha256',row_event."payloadHash",
   'event',row_event.payload,
   'dispatch_authorized',false,'publishable',false);
 IF EXISTS(SELECT 1 FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
      WHERE a."postId"=pid AND a.proof->'manifest'->0->>'mime'='image/jpeg') THEN
  ctx:=postmill_live_image_context_v1(s->>'org_id',pid,task,target);
  pin:=postmill_live_image_pin_v1(pid,row_event.payload->'image');
  IF ctx IS NULL OR ctx->>'status' IS DISTINCT FROM 'pending'
     OR ctx->'state' IS DISTINCT FROM review->'review'->'last_confirmed_state' OR pin IS NULL
  THEN RAISE EXCEPTION 'EDITORIAL_LIVE_DELIVERY_INCONSISTENT' USING ERRCODE='55000'; END IF;
  envelope:=envelope||jsonb_build_object('native_pin',pin);
 END IF;
 RETURN envelope;
END $fn$;
CREATE OR REPLACE FUNCTION postmill_reserve_editorial_recovery_v1(
  s jsonb, task text, target text, eid text, digest text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE pending jsonb; first_at timestamp; last_at timestamp; attempts int;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000';
  END IF;
  IF eid IS NULL OR eid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$'
     OR s->'is_test' IS DISTINCT FROM 'true'::jsonb
     OR target IS DISTINCT FROM 'max:-73052031470103' THEN
    RAISE EXCEPTION 'EDITORIAL_RECOVERY_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(s->>'org_id',task)::text,0));
  pending := public.postmill_read_editorial_delivery_v1(s,task,target);
  IF pending IS NULL OR pending ? 'native_pin' THEN RETURN false; END IF;
  IF pending->>'event_id' IS DISTINCT FROM eid
     OR pending->>'payload_sha256' IS DISTINCT FROM digest THEN
    RAISE EXCEPTION 'EDITORIAL_RECOVERY_EVENT_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT "reservedAt" INTO first_at FROM "EditorialDeliveryReservation" WHERE "eventId"=eid;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::int,max("reservedAt") INTO attempts,last_at
    FROM "EditorialDeliveryRecovery" WHERE "eventId"=eid;
  IF attempts>=2 OR greatest(first_at,coalesce(last_at,first_at)) >
       clock_timestamp()::timestamp - interval '10 minutes' THEN
    RETURN false;
  END IF;
  INSERT INTO "EditorialDeliveryRecovery"("eventId",attempt,"reservedAt")
    VALUES (eid,attempts+1,clock_timestamp()::timestamp);
  RETURN true;
END $fn$;


REVOKE ALL ON FUNCTION postmill_live_image_pin_v1(text,jsonb),
 postmill_queue_editorial_decision_internal_v2(jsonb,text,text,text,jsonb,boolean),
 postmill_queue_editorial_live_human_v1(text,text,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
