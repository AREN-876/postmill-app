\set ON_ERROR_STOP on
-- Full native Prisma schema, disposable PostgreSQL 17 only. Roll back fixture.
BEGIN;
-- 028B.1: pg_temp SQL candidate; verifies metadata/digest, not JPEG decode
-- or signed remote authority. Entire fixture rolls back.
CREATE FUNCTION pg_temp.qualify_live_image_release_v1(
 org text, pid text, task text, target text, actor text, command jsonb,
 expected_state jsonb, expected_pin jsonb, verified_bytes bytea
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE
 v jsonb; review jsonb; confirmed jsonb; receipt jsonb; s jsonb;
 ctx jsonb; media jsonb; frozen_settings jsonb; manifest_ref jsonb;
 src public."Post"%ROWTYPE; i public."Integration"%ROWTYPE; prior public."EditorialRelease"%ROWTYPE;
 pubid text; timeutc timestamp(3); at_instant timestamptz;
 cmd text; action text; requested_at text; times jsonb; current_target jsonb;
 utc_minute int; created_at timestamptz:=clock_timestamp();
BEGIN
 -- Transaction-local CI candidate only; never installed by migrations.
 IF current_database() NOT IN ('postmill_image_ci','edx_upgrade_restored_44','postmill-editorial-restore-ci')
 OR org IS DISTINCT FROM 'org-modes' OR target IS DISTINCT FROM 'max:-73052031470103' THEN
  RAISE EXCEPTION 'EDITORIAL_LIVE_RELEASE_ISOLATED_ONLY' USING ERRCODE='55000';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000';
 END IF;
 IF (org ~ '^[A-Za-z0-9_.:-]{1,200}$'
  AND pid ~ '^[0-9a-f]{32}$'
  AND task ~ '^[1-9][0-9]{0,18}$'
  AND (length(task)<19 OR task<='9223372036854775807')
  AND length(target) BETWEEN 1 AND 200
  AND actor ~ '^[A-Za-z0-9_.:-]{1,200}$'
  AND jsonb_typeof(command)='object' AND octet_length(command::text)<=1000
  AND command ?& ARRAY['command_id','action','publish_at']
  AND command-ARRAY['command_id','action','publish_at']='{}'::jsonb
  AND jsonb_typeof(command->'command_id')='string'
  AND command->>'command_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND command->>'action' IN ('publish_now','queue')
  AND ((command->>'action'='publish_now' AND command->'publish_at'='null'::jsonb)
    OR (command->>'action'='queue' AND jsonb_typeof(command->'publish_at')='string'
     AND command->>'publish_at' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00([.]000)?Z$'))
 ) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_RELEASE_INVALID' USING ERRCODE='22023';
 END IF;
 cmd:=command->>'command_id'; action:=command->>'action';
 requested_at:=command->>'publish_at';

 -- Consistent lock order with the 06A/06B editor boundary; channel lock also
 -- serializes concurrent editorial release reservations for this integration.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,task)::text,0));
 v:=postmill_read_editorial_human_v1(org,pid,task,target);
 IF v IS NULL THEN RETURN NULL; END IF;

 ctx:=postmill_live_image_context_v1(org,pid,task,target);
 IF ctx IS NULL OR ctx->>'status' IS DISTINCT FROM 'idle'
 OR ctx->'state' IS DISTINCT FROM expected_state
 OR jsonb_typeof(ctx->'media') IS DISTINCT FROM 'object'
 OR expected_pin IS NULL
 OR postmill_live_image_pin_v1(pid,expected_state->'image') IS DISTINCT FROM expected_pin
 OR verified_bytes IS NULL OR octet_length(verified_bytes) NOT BETWEEN 4 AND 8388608
 THEN RAISE EXCEPTION 'EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH' USING ERRCODE='55000'; END IF;
 media:=ctx->'media';
 IF media->>'sha256' IS DISTINCT FROM encode(sha256(verified_bytes),'hex')
 OR media->'size_bytes' IS DISTINCT FROM to_jsonb(octet_length(verified_bytes))
 OR media->>'mime' IS DISTINCT FROM 'image/jpeg'
 THEN RAISE EXCEPTION 'EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH' USING ERRCODE='55000'; END IF;
 SELECT a.proof->'manifest' INTO manifest_ref
 FROM "EditorialImageImport" a JOIN "EditorialImageImportReceipt" b ON b."importId"=a.id
 WHERE a."postId"=pid AND b."fileId"=media->>'file_id'
 AND a.proof->'state'->'image'=expected_state->'image';
 IF NOT FOUND OR encode(sha256(convert_to(manifest_ref::text,'UTF8')),'hex') IS DISTINCT FROM expected_state->'image'->>'sha256'
 THEN RAISE EXCEPTION 'EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH' USING ERRCODE='55000'; END IF;

 SELECT * INTO prior FROM public."EditorialRelease" r WHERE r."sourcePostId"=pid;
 IF FOUND THEN
  -- The original release is the only valid result; a retry never creates a
  -- second publication or another dispatch even after a lost HTTP response.
  IF prior."commandId" IS DISTINCT FROM cmd
    OR prior.mode IS DISTINCT FROM action
    OR prior."actorId" IS DISTINCT FROM actor
    OR prior."confirmedSeq" IS DISTINCT FROM expected_state->>'seq'
    OR (action='queue' AND
        to_char(prior."publishAt",'YYYY-MM-DD"T"HH24:MI:SS"Z"') IS DISTINCT FROM
        regexp_replace(requested_at,'[.]000Z$','Z')) THEN
   RAISE EXCEPTION 'EDITORIAL_RELEASE_ALREADY_EXISTS' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('created',false,'source_post_id',pid,
   'publication_post_id',prior."publicationPostId",'mode',prior.mode,
   'publish_at',to_char(prior."publishAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'status','already_recorded','publishable',false,'dispatch_authorized',false);
 END IF;

 review:=v->'review'; confirmed:=review->'last_confirmed_state';
 receipt:=v->'receipt';
 IF (v->'review_acknowledged'='true'::jsonb
  AND review->>'status'='idle'
  AND confirmed->'binding'=receipt->'binding'
  AND confirmed->'text'=receipt->'text'
  AND confirmed->>'text_status'='approved'
  AND confirmed->'final_approved'='true'::jsonb
  AND confirmed->'rejected'='false'::jsonb
  AND confirmed=expected_state
  AND confirmed->>'image_mode' IN ('automatic','manual','after_text_approval')
  AND jsonb_typeof(confirmed->'image')='object'
  AND confirmed->'image_compatible'='true'::jsonb
  AND confirmed->'image_intent'='null'::jsonb
  AND confirmed->'text_request_id'='null'::jsonb
  AND confirmed->'image'->'revision'=media->'revision'
  AND confirmed->'dispatch_authorized'='false'::jsonb
  AND confirmed->'publishable'='false'::jsonb
  AND confirmed->>'seq' ~ '^[1-9][0-9]{0,18}$'
  AND EXISTS(
   SELECT 1 FROM public."EditorialDecisionOutbox" o
   JOIN public."EditorialDecisionResult" r ON r."eventId"=o."eventId"
   WHERE o."postId"=pid AND o."eventId"=review->>'latest_event_id'
    AND o.payload->>'action'='approve_final'
    AND o.payload->'text'=confirmed->'text' AND o.payload->'image'=confirmed->'image'
    AND r.outcome->>'status'='accepted'
    AND r.outcome->'state'=confirmed
  )) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_RELEASE_NOT_APPROVED' USING ERRCODE='55000';
 END IF;

 SELECT * INTO src FROM public."Post" WHERE id=pid AND "organizationId"=org FOR SHARE;
 IF NOT FOUND OR src.state<>'DRAFT' OR src."editorialTaskId" IS DISTINCT FROM task THEN
  RAISE EXCEPTION 'EDITORIAL_RELEASE_SOURCE_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT * INTO i FROM public."Integration" WHERE id=src."integrationId"
  AND "organizationId"=org AND "internalId"=target AND "providerIdentifier"='max'
  AND NOT disabled AND NOT "refreshNeeded" AND NOT "inBetweenSteps"
  AND "deletedAt" IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_RELEASE_TARGET_CHANGED' USING ERRCODE='55000'; END IF;
 current_target:=postmill_check_editorial_target_v1(
  (SELECT r.request->'scope' FROM public."EditorialDraftReceipt" r WHERE r."postId"=pid),target);
 IF current_target IS DISTINCT FROM
   (SELECT r."targetSnapshot" FROM public."EditorialDraftReceipt" r WHERE r."postId"=pid) THEN
  RAISE EXCEPTION 'EDITORIAL_RELEASE_TARGET_CHANGED' USING ERRCODE='55000';
 END IF;

 PERFORM pg_advisory_xact_lock(hashtextextended(
   jsonb_build_array('editorial-release-channel',org,i.id)::text,0));
 IF action='publish_now' THEN
  timeutc:=(created_at AT TIME ZONE 'UTC')::timestamp(3);
 ELSE
  -- Explicit operator-chosen preview time must still be a future, configured
  -- UTC slot on this exact channel; preview alone is not reservation.
  BEGIN
   at_instant:=requested_at::timestamptz;
  EXCEPTION WHEN OTHERS THEN
   RAISE EXCEPTION 'EDITORIAL_RELEASE_INVALID_TIME' USING ERRCODE='22023';
  END;
  timeutc:=(at_instant AT TIME ZONE 'UTC')::timestamp(3);
  IF at_instant <= clock_timestamp() + interval '10 seconds'
    OR timeutc > (clock_timestamp() AT TIME ZONE 'UTC') + interval '366 days' THEN
   RAISE EXCEPTION 'EDITORIAL_RELEASE_INVALID_TIME' USING ERRCODE='22023';
  END IF;
  BEGIN
    times:=i."postingTimes"::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'EDITORIAL_RELEASE_INVALID_GRID' USING ERRCODE='22023';
  END;
  utc_minute:=extract(hour from timeutc)::int*60+extract(minute from timeutc)::int;
  IF (jsonb_typeof(times)='array' AND EXISTS(
     SELECT 1 FROM jsonb_array_elements(times) x
     WHERE x->>'time'=utc_minute::text
  )) IS NOT TRUE THEN
   RAISE EXCEPTION 'EDITORIAL_RELEASE_NOT_IN_GRID' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public."Post" p WHERE p."organizationId"=org
   AND p."integrationId"=i.id AND p."publishDate"=timeutc
   AND p."deletedAt" IS NULL AND p.state IN ('QUEUE','PUBLISHING')) THEN
   RAISE EXCEPTION 'EDITORIAL_RELEASE_SLOT_OCCUPIED' USING ERRCODE='55000';
  END IF;
 END IF;

 -- StoryGo photos use native settings, not Post.image, which must remain
 -- empty for story mode. The source stays byte-for-byte unchanged.
 IF src.image IS DISTINCT FROM '[]'
 OR jsonb_typeof(src.settings::jsonb) IS DISTINCT FROM 'object'
 OR src.settings::jsonb ?| ARRAY['storyImageId','storyImageSha256','__gateway','__maxMedia']
 THEN RAISE EXCEPTION 'EDITORIAL_LIVE_RELEASE_SOURCE_CHANGED' USING ERRCODE='55000'; END IF;
 frozen_settings:=src.settings::jsonb||jsonb_build_object(
   'storyImageId',media->>'file_id','storyImageSha256',media->>'sha256');
 pubid:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO public."Post"(
   id,"organizationId","integrationId","campaignId","group",state,
   "publishDate",content,settings,image,"creationMethod","updatedAt",
   "approvalStatus","approvedById","approvedAt","maxScheduleRevision","maxTarget"
 ) VALUES(
   pubid,org,i.id,src."campaignId",'edx-release-'||pubid,'QUEUE',
   timeutc,src.content,frozen_settings::text,'[]','API',now(),
   'approved',actor,now(),1,
   jsonb_build_object(
    'integrationId',i.id,'internalId',i."internalId",
    'providerConfigId',i."providerConfigId",
    'version',coalesce(i."providerVersion",'v1'),
    'tokenHash',current_target->>'tokenHash')
 );
 INSERT INTO public."EditorialRelease"(
   "sourcePostId","publicationPostId","commandId",mode,
   "publishAt","actorId","confirmedSeq"
 ) VALUES(pid,pubid,cmd,action,timeutc,actor,confirmed->>'seq');
 RETURN jsonb_build_object('created',true,'source_post_id',pid,
  'publication_post_id',pubid,'mode',action,
  'publish_at',to_char(timeutc,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'status','isolated_native_queue_fixture','publishable',false,'dispatch_authorized',false,
  'provider_version',coalesce(i."providerVersion",'v1'));
END $fn$;

-- 028B.2A: temporary native preflight projection, not a send grant.
CREATE FUNCTION pg_temp.qualify_live_release_photo_v1(org text,pub text,occ text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r "EditorialRelease"%ROWTYPE; src "Post"%ROWTYPE; dst "Post"%ROWTYPE;
 o "MaxDeliveryOccurrence"%ROWTYPE; ctx jsonb; st jsonb; media jsonb; pin jsonb;
 integ "Integration"%ROWTYPE; target constant text:='max:-73052031470103';
BEGIN
 IF current_database() NOT IN ('postmill_image_ci','edx_upgrade_restored_44','postmill-editorial-restore-ci')
 OR org IS DISTINCT FROM 'org-modes' OR occ !~ '^max_[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO r FROM "EditorialRelease" WHERE "publicationPostId"=pub;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO src FROM "Post" WHERE id=r."sourcePostId" AND "organizationId"=org;
 IF NOT FOUND OR src."editorialTaskId" IS NULL THEN RETURN NULL; END IF;
 -- Separate READ COMMITTED query, never under the worker's Post row lock.
 ctx:=postmill_live_image_context_v1(org,src.id,src."editorialTaskId",target);
 IF ctx IS NULL OR ctx->>'status' IS DISTINCT FROM 'idle' THEN RETURN NULL; END IF;
 st:=ctx->'state'; media:=ctx->'media'; pin:=postmill_live_image_pin_v1(src.id,st->'image');
 IF (st->>'seq'=r."confirmedSeq" AND st->'final_approved'='true'::jsonb
 AND st->'rejected'='false'::jsonb AND st->'image_compatible'='true'::jsonb
 AND st->>'text_status'='approved' AND st->'image_intent'='null'::jsonb
 AND st->'text_request_id'='null'::jsonb AND pin IS NOT NULL
 AND jsonb_typeof(media)='object') IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT * INTO dst FROM "Post" WHERE id=pub AND "organizationId"=org;
 IF NOT FOUND OR (dst.state='QUEUE' AND dst."deletedAt" IS NULL
 AND dst."editorialTaskId" IS NULL AND dst."editorialProfileRef" IS NULL
 AND dst."integrationId"=src."integrationId" AND dst."campaignId"=src."campaignId"
 AND dst."parentPostId" IS NULL AND dst."intervalInDays" IS NULL
 AND dst."publishDate"=r."publishAt" AND dst."maxScheduleRevision"=1
 AND dst."approvalStatus"='approved' AND dst."approvedById"=r."actorId"
 AND dst.content=src.content AND dst.image='[]'
 AND dst.settings::jsonb=(src.settings::jsonb||jsonb_build_object(
  'storyImageId',media->>'file_id','storyImageSha256',media->>'sha256'))
 AND NOT EXISTS(SELECT 1 FROM "Post" child WHERE child."parentPostId"=dst.id)) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT * INTO integ FROM "Integration" WHERE id=dst."integrationId" AND "organizationId"=org
 AND "internalId"=target AND "providerIdentifier"='max' AND NOT disabled
 AND NOT "refreshNeeded" AND NOT "inBetweenSteps" AND "deletedAt" IS NULL;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF dst."maxTarget" IS DISTINCT FROM jsonb_build_object(
  'integrationId',integ.id,'internalId',integ."internalId",
  'providerConfigId',integ."providerConfigId",'version',coalesce(integ."providerVersion",'v1'),
  'tokenHash',postmill_check_editorial_target_v1(ctx->'scope',target)->>'tokenHash')
 THEN RETURN NULL; END IF;
 SELECT * INTO o FROM "MaxDeliveryOccurrence" WHERE id=occ AND "postId"=pub AND "organizationId"=org;
 IF NOT FOUND OR (o.state='READY' AND o.attempt=0 AND o."parentId" IS NULL
 AND o."scheduledAt"=dst."publishDate"
 AND o."scheduledAt"<=clock_timestamp() AND o.fingerprint ~ '^[0-9a-f]{64}$') IS NOT TRUE
 THEN RETURN NULL; END IF;
 -- Fingerprint equality is the existing native begin() responsibility.
 RETURN jsonb_build_object('publication_post_id',pub,'source_post_id',src.id,
  'occurrence_id',occ,'attempt',1,'confirmed_seq',r."confirmedSeq",
  'target',target,'request',jsonb_build_object('org_id',org,'task_id',src."editorialTaskId",
    'channel_id',ctx->'scope'->>'channel_id','state',st),
  'pin',pin,'media',media,'dispatch_authorized',false,'publishable',false);
END $fn$;

DO $test$
DECLARE s jsonb; task text:='9071'; target text:='max:-73052031470103'; pid text;
 body jsonb; p jsonb; st jsonb; ev jsonb; a jsonb; proof jsonb; claim jsonb; res jsonb; ctx jsonb;
  png bytea:=decode('ffd8ffd9','hex'); -- metadata-only SQL fixture; decoder tested separately
 digest text; path text;
 fid text; i int; queued jsonb; decision jsonb; next_state jsonb; reply jsonb;
 final_state jsonb; command jsonb; release_result jsonb; pubid text; source_before jsonb;
 action text; bad jsonb; occurrence text:='max_'||repeat('d',64); projection jsonb;
BEGIN
 INSERT INTO "Organization"(id,name,"updatedAt") VALUES('org-modes','Mock image CI',now());
 INSERT INTO "Integration"(id,"organizationId","internalId",name,"providerIdentifier",type,token)
 VALUES('mock-review-native','org-modes',target,'Mock image CI','max','max','not-a-real-token');
 INSERT INTO "Campaign"(id,"organizationId",name,"updatedAt")
 VALUES('mock-image-campaign','org-modes','Mock image CI',now());
 s:=jsonb_build_object('org_id','org-modes','integration_id','mock-review-native','campaign_id','mock-image-campaign',
  'channel_id','42','profile_ref','review-ci@v3','is_test',true,'image_mode','automatic');
 body:=jsonb_build_object('title','Mock native image CI','parts',jsonb_build_array(repeat('a',2900),repeat('b',2900),repeat('c',2900)));
 p:=jsonb_build_object('schema_version',1,'task_id',task,'scope',s,'content',body,
  'text',jsonb_build_object('revision',1,'sha256',encode(sha256(convert_to(body::text,'UTF8')),'hex')),
  'firstPart',(body->>'title')||E'\n\n'||(body->'parts'->>0),'continuationText',(body->'parts'->>1)||E'\n────────────────────────\n'||(body->'parts'->>2));
 res:=postmill_exchange_create_v1(p,target); pid:=res->'receipt'->'binding'->>'post_id';
 st:=jsonb_build_object('binding',res->'receipt'->'binding','seq','0','image_mode','automatic',
  'text_status','pending','text_request_id',NULL,'text',p->'text','image',NULL,'image_compatible',false,
  'image_intent','initial:1','rejected',false,'final_approved',false,'dispatch_authorized',false,'publishable',false);
 PERFORM postmill_anchor_editorial_review_v1(s,task,target,st);
 digest:=encode(sha256(png),'hex');
 a:=jsonb_build_object('asset_id',gen_random_uuid()::text,'sha256',digest,'mime','image/jpeg','width',1152,'height',768,
  'size_bytes',octet_length(png),'provider','fal','model','fal-ai/flux-2/klein/9b','plan_id',gen_random_uuid()::text);
 ev:=jsonb_build_object('schema_version',1,'event_id','live-image:'||(a->>'plan_id'),'producer','operator','actor_id','ci-owner',
  'occurred_at','2026-11-24T08:00:00Z','binding',st->'binding','expected_seq','0','action','install_image',
  'text',st->'text','image',NULL,'feedback','','request_id','initial:1',
  'revision_content',jsonb_build_object('plan_id',a->'plan_id','plan_sha256',repeat('e',64),'asset_sha256',digest));
 proof:=jsonb_build_object('channel_id','42','install_event_id',ev->>'event_id','install_event',ev,
  'install_payload_sha256',encode(sha256(convert_to(ev::text,'UTF8')),'hex'),'manifest',jsonb_build_array(a),
  'state',st||jsonb_build_object('seq','1','image',jsonb_build_object('revision',1,
   'sha256',encode(sha256(convert_to(jsonb_build_array(a)::text,'UTF8')),'hex')),
   'image_compatible',true,'image_intent',NULL),'publishable',false,'dispatch_authorized',false);
 ASSERT postmill_live_image_context_v1('org-other',pid,task,target) IS NULL;
 ASSERT postmill_live_image_context_v1('org-modes',pid,task,'other-target') IS NULL;
 BEGIN
  PERFORM postmill_reserve_live_image_import_v1('org-modes',pid,task,target,jsonb_set(proof,'{state,text,revision}','2'));
  RAISE EXCEPTION 'tampered image proof accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_PROOF_STATE_MISMATCH'; END;
 -- Recompute event digest after tampering to exercise structural validation,
 -- not just the outer hash mismatch.
 bad:=jsonb_set(proof,'{install_event,revision_content,unexpected}','true');
 bad:=jsonb_set(bad,'{install_payload_sha256}',to_jsonb(encode(sha256(convert_to((bad->'install_event')::text,'UTF8')),'hex')));
 BEGIN
  PERFORM postmill_reserve_live_image_import_v1('org-modes',pid,task,target,bad);
  RAISE EXCEPTION 'extra revision content accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_PROOF_INVALID'; END;
 claim:=postmill_reserve_live_image_import_v1('org-modes',pid,task,target,proof);
 ASSERT claim->>'status'='reserved';
 path:='editorial-private:v1:'||(claim->>'import_id')||'.jpg';
 ASSERT postmill_editorial_confirmed_v1(pid)->>'status'='image_import_uncertain';
 ASSERT postmill_reserve_live_image_import_v1('org-modes',pid,task,target,proof)->>'status'='uncertain';
 ASSERT NOT(postmill_reserve_live_image_import_v1('org-modes',pid,task,target,proof) ? 'token');
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-modes',pid,task,target,'ci-editor',
   jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq','0','action','approve_text','feedback',''));
  RAISE EXCEPTION 'decision overtook import';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_IMPORT_UNRESOLVED'; END;
 BEGIN
  PERFORM postmill_finish_live_image_import_v1('org-modes',pid,task,target,claim->>'import_id',gen_random_uuid()::text,path,digest,octet_length(png));
  RAISE EXCEPTION 'wrong token accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_STORAGE_INVALID'; END;
 BEGIN
  PERFORM postmill_finish_live_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',path,repeat('0',64),octet_length(png));
  RAISE EXCEPTION 'wrong digest accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_STORAGE_INVALID'; END;
 BEGIN
  PERFORM postmill_finish_live_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',
    '/uploads/org-modes/2026/11/24/'||repeat('a',32)||'.jpg',digest,octet_length(png));
  RAISE EXCEPTION 'public path accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_STORAGE_INVALID'; END;
 BEGIN
  PERFORM postmill_finish_live_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',
    'editorial-private:v1:'||gen_random_uuid()::text||'.jpg',digest,octet_length(png));
  RAISE EXCEPTION 'foreign private key accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_STORAGE_INVALID'; END;
 ASSERT (SELECT count(*) FROM "File" WHERE "organizationId"='org-modes')=0;
 res:=postmill_finish_live_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',path,digest,octet_length(png));
 ASSERT res->>'status'='recorded'; fid:=res->>'file_id';
 ASSERT postmill_finish_live_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',path,digest,octet_length(png))=res;
 ASSERT postmill_reserve_live_image_import_v1('org-modes',pid,task,target,proof)->>'status'='recorded';
 ASSERT (SELECT count(*) FROM "File" WHERE "organizationId"='org-modes')=1;
 ASSERT (SELECT count(*) FROM "EditorialImageImportReceipt" WHERE "fileId"=fid)=1;
 ASSERT postmill_editorial_confirmed_v1(pid)->'last_confirmed_state'=proof->'state';
 ASSERT postmill_editorial_confirmed_v1(pid)->>'status'='idle';
 ctx:=postmill_live_image_context_v1('org-modes',pid,task,target);
 ASSERT ctx->'media'->>'file_id'=fid AND ctx->'media'->>'sha256'=digest;
 ASSERT (SELECT image='[]' AND state='DRAFT' AND "approvalStatus"='pending' FROM "Post" WHERE id=pid);
 ASSERT NOT EXISTS(SELECT 1 FROM "EditorialRelease" WHERE "sourcePostId"=pid);
 BEGIN
  DELETE FROM "EditorialImageImportReceipt" WHERE "fileId"=fid;
  RAISE EXCEPTION 'receipt deleted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_DECISION_LEDGER_IMMUTABLE'; END;
 BEGIN
  UPDATE "File" SET path='tampered' WHERE id=fid;
  RAISE EXCEPTION 'media modified';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_FILE_IMMUTABLE'; END;
 BEGIN
  DELETE FROM "File" WHERE id=fid;
  RAISE EXCEPTION 'media removed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_FILE_IMMUTABLE'; END;
 BEGIN
  UPDATE "Post" SET image='[{"path":"tampered"}]' WHERE id=pid;
  RAISE EXCEPTION 'native draft image bypass';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_MANAGED_DRAFT_FROZEN'; END;

 -- Queue through the separate native boundary, retaining the existing outbox.
 command:=jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq','1','action','approve_text','feedback','');
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-modes',pid,task,target,'ci-editor',command);
  RAISE EXCEPTION 'legacy queue accepted live image';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_LIVE_DECISION_ROUTE_MISMATCH'; END;
 BEGIN
  PERFORM postmill_queue_editorial_live_human_v1('org-modes',pid,task,target,'ci-editor',jsonb_set(command,'{expected_seq}','"0"'));
  RAISE EXCEPTION 'stale live command accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_STALE_DECISION'; END;
 queued:=postmill_queue_editorial_live_human_v1('org-modes',pid,task,target,'ci-editor',command);
 ASSERT queued->>'status'='queued/unconfirmed' AND queued->'newly_queued'='true'::jsonb;
 ASSERT postmill_queue_editorial_live_human_v1('org-modes',pid,task,target,'ci-editor',command)->'replay'='true'::jsonb;
 decision:=postmill_read_editorial_delivery_v1(s,task,target);
 ASSERT decision->'native_pin'=jsonb_build_object('plan_id',a->>'plan_id','native_file_id',fid,'asset_sha256',digest);
 ASSERT decision->>'event_id'=queued->>'event_id';
 ASSERT postmill_reserve_editorial_delivery_v1(s,task,target,queued->>'event_id')->'newly_reserved'='true'::jsonb;
 ASSERT postmill_reserve_editorial_delivery_v1(s,task,target,queued->>'event_id')->'newly_reserved'='false'::jsonb;
 ASSERT NOT postmill_reserve_editorial_recovery_v1(s,task,target,queued->>'event_id',decision->>'payload_sha256');
 next_state:=postmill_editorial_next_state_v1(proof->'state',decision->'event');
 reply:=jsonb_build_object('status','accepted','reason',NULL,'state',next_state,'publishable',false,'dispatch_authorized',false,'newly_applied',true,'replay',false);
 ASSERT postmill_import_editorial_result_v1(s,task,target,queued->>'event_id',decision->>'payload_sha256',reply)->'newly_recorded'='true'::jsonb;
 ASSERT postmill_editorial_confirmed_v1(pid)->'last_confirmed_state'=next_state;
 ASSERT postmill_read_editorial_delivery_v1(s,task,target) IS NULL;
 ASSERT (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=pid)=1;
 ASSERT NOT EXISTS(SELECT 1 FROM "EditorialDeliveryRecovery" WHERE "eventId"=queued->>'event_id');
 ASSERT NOT EXISTS(SELECT 1 FROM "EditorialRelease" WHERE "sourcePostId"=pid);
 -- 028B.1: final approval, exact pin, digest, one immutable copy.
 command:=jsonb_build_object('command_id',gen_random_uuid()::text,'action','publish_now','publish_at',NULL);
 BEGIN
  PERFORM pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,next_state,decision->'native_pin',png);
  RAISE EXCEPTION 'release before final approval accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_RELEASE_NOT_APPROVED'; END;
 final_state:=next_state;
 queued:=postmill_queue_editorial_live_human_v1('org-modes',pid,task,target,'ci-editor',
  jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq',final_state->>'seq','action','approve_final','feedback',''));
 decision:=postmill_read_editorial_delivery_v1(s,task,target);
 ASSERT decision->'native_pin'=jsonb_build_object('plan_id',a->>'plan_id','native_file_id',fid,'asset_sha256',digest);
 BEGIN
  PERFORM pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,final_state,decision->'native_pin',png);
  RAISE EXCEPTION 'release overtook pending approval';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH'; END;
 ASSERT postmill_reserve_editorial_delivery_v1(s,task,target,queued->>'event_id')->'newly_reserved'='true'::jsonb;
 next_state:=postmill_editorial_next_state_v1(final_state,decision->'event');
 reply:=jsonb_build_object('status','accepted','reason',NULL,'state',next_state,'publishable',false,'dispatch_authorized',false,'newly_applied',true,'replay',false);
 ASSERT postmill_import_editorial_result_v1(s,task,target,queued->>'event_id',decision->>'payload_sha256',reply)->'newly_recorded'='true'::jsonb;
 ASSERT next_state->'final_approved'='true'::jsonb;
 ASSERT postmill_editorial_confirmed_v1(pid)->'last_confirmed_state'=next_state;
 BEGIN
  PERFORM postmill_release_editorial_story_v1('org-modes',pid,task,target,'ci-editor',command);
  RAISE EXCEPTION 'legacy release accepted JPEG';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_RELEASE_NOT_APPROVED'; END;
 BEGIN
  PERFORM pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,final_state,decision->'native_pin',png);
  RAISE EXCEPTION 'stale release accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH'; END;
 BEGIN
  PERFORM pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,next_state,
    jsonb_set(decision->'native_pin','{native_file_id}',to_jsonb(gen_random_uuid()::text)),png);
  RAISE EXCEPTION 'wrong pin accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH'; END;
 BEGIN
  PERFORM pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,next_state,decision->'native_pin',decode('ffd8ffd8','hex'));
  RAISE EXCEPTION 'wrong digest accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_LIVE_RELEASE_IMAGE_MISMATCH'; END;
 ASSERT NOT EXISTS(SELECT 1 FROM "EditorialRelease" WHERE "sourcePostId"=pid);
 SELECT to_jsonb(srcrow) INTO source_before FROM "Post" srcrow WHERE id=pid;
 release_result:=pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,next_state,decision->'native_pin',png);
 ASSERT release_result->'created'='true'::jsonb AND release_result->'publishable'='false'::jsonb AND release_result->'dispatch_authorized'='false'::jsonb;
 pubid:=release_result->>'publication_post_id';
 ASSERT (SELECT to_jsonb(srcrow)=source_before FROM "Post" srcrow WHERE id=pid);
 ASSERT (SELECT state='QUEUE' AND image='[]' AND "editorialTaskId" IS NULL
   AND settings::jsonb->>'storyImageId'=fid AND settings::jsonb->>'storyImageSha256'=digest
   AND settings::jsonb - ARRAY['storyImageId','storyImageSha256']=(source_before->>'settings')::jsonb
   AND content=source_before->>'content' FROM "Post" WHERE id=pubid);
 ASSERT (SELECT "publicationPostId"=pubid AND "confirmedSeq"=next_state->>'seq' FROM "EditorialRelease" WHERE "sourcePostId"=pid);
 ASSERT pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',command,next_state,decision->'native_pin',png)->'created'='false'::jsonb;
 BEGIN
  PERFORM pg_temp.qualify_live_image_release_v1('org-modes',pid,task,target,'ci-editor',
    jsonb_set(command,'{command_id}',to_jsonb(gen_random_uuid()::text)),next_state,decision->'native_pin',png);
  RAISE EXCEPTION 'second release accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_RELEASE_ALREADY_EXISTS'; END;
 BEGIN
  UPDATE "Post" SET settings=(settings::jsonb||jsonb_build_object('storyImageSha256',repeat('0',64)))::text WHERE id=pubid;
  RAISE EXCEPTION 'publication digest mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_PUBLICATION_IMMUTABLE'; END;
 ASSERT (SELECT count(*) FROM "EditorialRelease" WHERE "sourcePostId"=pid)=1;
 -- 028B.2A: read projection of a due initial occurrence; no send authority.
 ASSERT pg_temp.qualify_live_release_photo_v1('org-modes',pubid,occurrence) IS NULL;
 INSERT INTO "MaxDeliveryOccurrence"(id,"postId","organizationId","scheduledAt",fingerprint,"updatedAt")
 SELECT occurrence,pubid,'org-modes',"publishDate",repeat('c',64),now() FROM "Post" WHERE id=pubid;
 projection:=pg_temp.qualify_live_release_photo_v1('org-modes',pubid,occurrence);
 ASSERT projection IS NOT NULL AND projection->'request'->'state'=next_state
 AND projection->'pin'=decision->'native_pin' AND projection->'media'->>'path'=path
 AND projection->>'confirmed_seq'=next_state->>'seq'
 AND projection->'dispatch_authorized'='false'::jsonb;
 ASSERT pg_temp.qualify_live_release_photo_v1('other',pubid,occurrence) IS NULL;
 ASSERT pg_temp.qualify_live_release_photo_v1('org-modes',pid,occurrence) IS NULL;
 ASSERT pg_temp.qualify_live_release_photo_v1('org-modes',pubid,gen_random_uuid()::text) IS NULL;
 UPDATE "MaxDeliveryOccurrence" SET continued=true WHERE id=occurrence;
 ASSERT pg_temp.qualify_live_release_photo_v1('org-modes',pubid,occurrence)=projection;
 UPDATE "MaxDeliveryOccurrence" SET state='STARTED',attempt=1 WHERE id=occurrence;
 ASSERT pg_temp.qualify_live_release_photo_v1('org-modes',pubid,occurrence) IS NULL;
 ASSERT (SELECT state='QUEUE' FROM "Post" WHERE id=pubid);
END $test$;
ROLLBACK;
SELECT 'POSTMILL_LIVE_IMAGE_IMPORT_SQL_OK';
SELECT 'POSTMILL_028B1_LIVE_IMAGE_RELEASE_SQL_OK';

SELECT 'POSTMILL_028B2A_PRIVATE_PHOTO_PROJECTION_SQL_OK';
