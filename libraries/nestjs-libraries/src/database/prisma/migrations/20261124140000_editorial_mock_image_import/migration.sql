-- Mock image import: native storage object + atomic File and immutable receipt.
-- No production activation, publication, Post.image mutation or paid operations.
BEGIN;
CREATE TABLE "EditorialImageImport" (
 id TEXT NOT NULL PRIMARY KEY,
 "postId" TEXT NOT NULL REFERENCES "EditorialDraftReceipt"("postId") ON DELETE RESTRICT ON UPDATE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>=1),
 "installEventId" TEXT NOT NULL,
 proof JSONB NOT NULL,
 "proofHash" TEXT NOT NULL,
 "beforeState" JSONB NOT NULL,
 token TEXT NOT NULL,
 "fileId" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EditorialImageImport_integrity" CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=32768
  AND "proofHash"=encode(sha256(convert_to(proof::text,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX "EditorialImageImport_postId_revision_key" ON "EditorialImageImport"("postId",revision);
CREATE UNIQUE INDEX "EditorialImageImport_postId_installEventId_key" ON "EditorialImageImport"("postId","installEventId");
CREATE UNIQUE INDEX "EditorialImageImport_fileId_key" ON "EditorialImageImport"("fileId");
CREATE TABLE "EditorialImageImportReceipt" (
 "importId" TEXT NOT NULL PRIMARY KEY REFERENCES "EditorialImageImport"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "fileId" TEXT NOT NULL REFERENCES "File"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "storagePath" TEXT NOT NULL,
 "assetSha256" TEXT NOT NULL CHECK("assetSha256" ~ '^[0-9a-f]{64}$'),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "EditorialImageImportReceipt_fileId_key" ON "EditorialImageImportReceipt"("fileId");
CREATE TRIGGER "EditorialImageImport_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialImageImport"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();
CREATE TRIGGER "EditorialImageImportReceipt_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialImageImportReceipt"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();
-- Native media rows are protected independently of the application.
CREATE FUNCTION postmill_mock_image_file_fence_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF EXISTS(SELECT 1 FROM "EditorialImageImportReceipt" r WHERE r."fileId"=OLD.id) THEN
  RAISE EXCEPTION 'EDITORIAL_IMAGE_FILE_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER "File_editorial_mock_fence_v1" BEFORE UPDATE OR DELETE ON "File"
 FOR EACH ROW EXECUTE FUNCTION postmill_mock_image_file_fence_v1();

CREATE OR REPLACE FUNCTION postmill_editorial_confirmed_v1(pid text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE last_state jsonb; revision_state jsonb; latest_event text; latest_outcome jsonb; review_status text:='idle';
BEGIN
 SELECT snapshot INTO last_state FROM "EditorialReviewAnchor" WHERE "postId"=pid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT r.outcome->'state' INTO latest_outcome
 FROM "EditorialDecisionOutbox" o JOIN "EditorialDecisionResult" r ON r."eventId"=o."eventId"
 WHERE o."postId"=pid AND r.outcome->>'status'='accepted'
 ORDER BY o."expectedSeq"::bigint DESC LIMIT 1;
 IF FOUND THEN last_state:=latest_outcome; END IF;
 SELECT proof->'state' INTO revision_state FROM "EditorialTextRevision"
 WHERE "postId"=pid ORDER BY revision DESC LIMIT 1;
 IF FOUND AND (revision_state->>'seq')::bigint>(last_state->>'seq')::bigint THEN
  last_state:=revision_state;
 END IF;
 SELECT a.proof->'state' INTO revision_state FROM "EditorialImageImport" a
 JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
 WHERE a."postId"=pid ORDER BY a.revision DESC LIMIT 1;
 IF FOUND AND (revision_state->>'seq')::bigint>(last_state->>'seq')::bigint THEN
  last_state:=revision_state;
 END IF;
 SELECT o."eventId",r.outcome INTO latest_event,latest_outcome
 FROM "EditorialDecisionOutbox" o LEFT JOIN "EditorialDecisionResult" r ON r."eventId"=o."eventId"
 WHERE o."postId"=pid ORDER BY o."expectedSeq"::bigint DESC LIMIT 1;
 IF FOUND THEN
  review_status:=CASE WHEN latest_outcome IS NULL THEN 'pending'
   WHEN latest_outcome->>'status'='rejected' THEN 'rejected' ELSE 'idle' END;
 END IF;
 IF EXISTS(SELECT 1 FROM "EditorialImageImport" a LEFT JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
  WHERE a."postId"=pid AND b."importId" IS NULL) THEN review_status:='image_import_uncertain'; END IF;
 RETURN jsonb_build_object('last_confirmed_state',last_state,'status',review_status,
  'latest_event_id',latest_event,'remote_current_verified',false,
  'dispatch_authorized',false,'publishable',false);
END $fn$;


CREATE OR REPLACE FUNCTION postmill_queue_editorial_decision_v1(s jsonb, task text, target text, actor text, command jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; anchor jsonb; pid text; action text; feedback text; cmd text;
 old "EditorialDecisionOutbox"%ROWTYPE; ev jsonb; eid text; h text; created boolean:=false; confirmed jsonb; remote_status text:='unconfirmed';
BEGIN
 IF (actor IS NOT NULL AND actor ~ '^[A-Za-z0-9_.:-]{1,200}$'
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
  IF anchor->>'image_mode'='disabled' AND anchor->>'text_status'='changes_requested' THEN
   RAISE EXCEPTION 'EDITORIAL_REVISION_AWAITING_IMPORT' USING ERRCODE='55000'; END IF;
  IF command->'expected_seq' IS DISTINCT FROM anchor->'seq'
    OR command->'text' IS DISTINCT FROM anchor->'text'
    OR command->'image' IS DISTINCT FROM anchor->'image'
    OR anchor->'binding' IS DISTINCT FROM verified->'receipt'->'binding'
    OR anchor->'text' IS DISTINCT FROM verified->'receipt'->'text' THEN
   RAISE EXCEPTION 'EDITORIAL_STALE_DECISION' USING ERRCODE='55000'; END IF;
  -- Same-artifact actions only. Revised native text/image is not supported
  -- by the initial target reconciliation boundary yet.
  IF action NOT IN ('approve_text','request_text_changes','reject','request_image') THEN
   RAISE EXCEPTION 'EDITORIAL_ACTION_BLOCKED' USING ERRCODE='55000'; END IF;
  IF (action='request_text_changes' AND feedback !~ '[^[:space:]]')
    OR (action<>'request_text_changes' AND feedback<>'') THEN
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


-- Trusted invoker context; not exposed directly to clients. Reuses target,
-- scope and frozen draft verification under the existing org/task lock.
CREATE FUNCTION postmill_mock_image_context_v1(org text,pid text,task text,target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s jsonb; verified jsonb; review jsonb; state jsonb; media jsonb;
BEGIN
 IF org IS DISTINCT FROM 'org-modes' OR target IS DISTINCT FROM 'max:-73052031470103'
 OR (pid ~ '^[0-9a-f]{32}$') IS NOT TRUE THEN RETURN NULL; END IF;
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
    'revision',a.revision,'size_bytes',f."fileSize",'mime','image/png')
  INTO media FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
   JOIN "File" f ON f.id=b."fileId"
  WHERE a."postId"=pid AND a.proof->'state'->'image'=state->'image'
   AND f."organizationId"=org AND f."deletedAt" IS NULL AND f."folderId" IS NULL
   AND f.path=b."storagePath" AND f."fileSize"=(a.proof->'manifest'->0->>'size_bytes')::int
   AND b."assetSha256"=a.proof->'manifest'->0->>'sha256'
   AND f.metadata->>'internal'='editorial-mock';
  IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_MEDIA_MISMATCH' USING ERRCODE='55000'; END IF;
 END IF;
 RETURN jsonb_build_object('scope',s,'state',state,'status',review->>'status','media',media,
 'publishable',false,'dispatch_authorized',false);
END $fn$;

-- Validate the exact next state independently of the authenticated TS receiver.
CREATE FUNCTION postmill_mock_image_validate_v1(ctx jsonb,p jsonb) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE before_state jsonb:=ctx->'state'; ev jsonb:=p->'install_event'; a jsonb:=p->'manifest'->0;
 next_state jsonb; rev integer; seq bigint;
 png bytea:=decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg==','base64');
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
 AND jsonb_typeof(a)='object' AND a ?& ARRAY['asset_id','sha256','mime','width','height','size_bytes','provider','model','job_id']
 AND a-ARRAY['asset_id','sha256','mime','width','height','size_bytes','provider','model','job_id']='{}'::jsonb
 AND a->>'asset_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND a->>'job_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 AND a->>'sha256'=encode(sha256(png),'hex') AND a->>'mime'='image/png'
 AND a->'width'='2'::jsonb AND a->'height'='2'::jsonb AND a->'size_bytes'=to_jsonb(octet_length(png))
 AND a->>'provider'='mock' AND a->>'model'='solid-rgb-v1'
 AND jsonb_typeof(ev)='object' AND ev ?& ARRAY['schema_version','event_id','producer','actor_id','occurred_at','binding','expected_seq','action','text','image','feedback','request_id','revision_content']
 AND ev-ARRAY['schema_version','event_id','producer','actor_id','occurred_at','binding','expected_seq','action','text','image','feedback','request_id','revision_content']='{}'::jsonb
 AND ev->'schema_version'='1'::jsonb AND ev->>'producer'='operator' AND ev->>'action'='install_image'
 AND ev->>'event_id'=p->>'install_event_id' AND length(ev->>'event_id') BETWEEN 1 AND 200
 AND length(ev->>'actor_id') BETWEEN 1 AND 200
 AND ev->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
 AND ev->'binding'=before_state->'binding' AND ev->'expected_seq'=before_state->'seq'
 AND ev->'text'=before_state->'text' AND ev->'image'=before_state->'image'
 AND ev->>'feedback'='' AND ev->'request_id'=before_state->'image_intent'
 AND ev->'revision_content'=jsonb_build_object('job_id',a->'job_id','asset_sha256',a->'sha256')
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

CREATE FUNCTION postmill_reserve_mock_image_import_v1(org text,pid text,task text,target text,p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE ctx jsonb; prior "EditorialImageImport"%ROWTYPE; rev integer; iid text; tok text; fid text;
BEGIN
 ctx:=postmill_mock_image_context_v1(org,pid,task,target);
 IF ctx IS NULL THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_SCOPE' USING ERRCODE='55000'; END IF;
 SELECT * INTO prior FROM "EditorialImageImport" WHERE "postId"=pid AND "installEventId"=p->>'install_event_id';
 IF FOUND THEN
  IF prior.proof IS DISTINCT FROM p THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_PROOF_CONFLICT' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('status',CASE WHEN EXISTS(SELECT 1 FROM "EditorialImageImportReceipt" WHERE "importId"=prior.id)
    THEN 'recorded' ELSE 'uncertain' END,'publishable',false,'dispatch_authorized',false);
 END IF;
 IF ctx->>'status'<>'idle' THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_UNRESOLVED' USING ERRCODE='55000'; END IF;
 rev:=postmill_mock_image_validate_v1(ctx,p);
 iid:=gen_random_uuid()::text; tok:=gen_random_uuid()::text; fid:=gen_random_uuid()::text;
 INSERT INTO "EditorialImageImport"(id,"postId",revision,"installEventId",proof,"proofHash","beforeState",token,"fileId")
 VALUES(iid,pid,rev,p->>'install_event_id',p,encode(sha256(convert_to(p::text,'UTF8')),'hex'),ctx->'state',tok,fid);
 RETURN jsonb_build_object('status','reserved','import_id',iid,'token',tok,'publishable',false,'dispatch_authorized',false);
END $fn$;

-- The trusted adapter must have written and read back the exact bytes before
-- calling this function. A crash after reservation remains uncertain, never
-- automatically re-writes or deletes storage. No binary data in SQL logs.
CREATE FUNCTION postmill_finish_mock_image_import_v1(org text,pid text,task text,target text,iid text,tok text,
 storage_path text,actual_sha text,actual_size int) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE ctx jsonb; imp "EditorialImageImport"%ROWTYPE; prior "EditorialImageImportReceipt"%ROWTYPE; a jsonb; rev integer;
BEGIN
 ctx:=postmill_mock_image_context_v1(org,pid,task,target);
 IF ctx IS NULL THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_SCOPE' USING ERRCODE='55000'; END IF;
 SELECT * INTO STRICT imp FROM "EditorialImageImport" WHERE id=iid AND "postId"=pid;
 a:=imp.proof->'manifest'->0;
 IF tok IS DISTINCT FROM imp.token OR actual_sha IS DISTINCT FROM a->>'sha256'
  OR actual_size IS DISTINCT FROM (a->>'size_bytes')::int
  OR storage_path IS NULL OR length(storage_path)>2048
  OR storage_path !~ '^((https?://[^/?#[:space:]]+)?/uploads/org-modes/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f]{32}[.]png)$'
 THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_STORAGE_INVALID' USING ERRCODE='22023'; END IF;
 SELECT * INTO prior FROM "EditorialImageImportReceipt" WHERE "importId"=iid;
 IF FOUND THEN
  IF prior."storagePath" IS DISTINCT FROM storage_path THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_STORAGE_CONFLICT' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('status','recorded','file_id',prior."fileId",'publishable',false,'dispatch_authorized',false);
 END IF;
 IF ctx->>'status'<>'image_import_uncertain' OR ctx->'state' IS DISTINCT FROM imp."beforeState"
 THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_STALE' USING ERRCODE='55000'; END IF;
 rev:=postmill_mock_image_validate_v1(ctx,imp.proof);
 IF rev<>imp.revision THEN RAISE EXCEPTION 'EDITORIAL_IMAGE_IMPORT_STALE' USING ERRCODE='55000'; END IF;
 INSERT INTO "File"(id,name,"originalName",path,"organizationId","fileSize",type,metadata,"updatedAt")
 VALUES(imp."fileId",'editorial-mock-'||imp.revision||'.png','editorial-mock.png',storage_path,org,actual_size,'image',
 jsonb_build_object('internal','editorial-mock','source','editorial','mimeType','image/png','sha256',actual_sha,
 'dimensions',jsonb_build_object('width',2,'height',2)),now());
 INSERT INTO "EditorialImageImportReceipt"("importId","fileId","storagePath","assetSha256")
 VALUES(iid,imp."fileId",storage_path,actual_sha);
 IF postmill_editorial_confirmed_v1(pid)->'last_confirmed_state' IS DISTINCT FROM imp.proof->'state' THEN
  RAISE EXCEPTION 'EDITORIAL_IMAGE_NATIVE_MISMATCH' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('status','recorded','file_id',imp."fileId",'publishable',false,'dispatch_authorized',false);
END $fn$;
REVOKE ALL ON "EditorialImageImport","EditorialImageImportReceipt" FROM PUBLIC;
REVOKE ALL ON FUNCTION postmill_mock_image_context_v1(text,text,text,text),
 postmill_mock_image_validate_v1(jsonb,jsonb),postmill_reserve_mock_image_import_v1(text,text,text,text,jsonb),
 postmill_finish_mock_image_import_v1(text,text,text,text,text,text,text,text,int),postmill_mock_image_file_fence_v1() FROM PUBLIC;
COMMIT;
