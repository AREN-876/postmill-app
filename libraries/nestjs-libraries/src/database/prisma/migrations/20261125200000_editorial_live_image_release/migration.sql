-- 61: live editorial release SQL boundary. No schema/table changes.
-- Trusted server invoker only, no PUBLIC grants and no default-on caller.
-- SQL checks metadata/hash/sequence, not JPEG decode or signed peer.
-- Human/worker code MUST independently validate signed current authority and
-- decode private bytes before calling; no production activation in this change.
BEGIN;
CREATE FUNCTION public.postmill_release_live_editorial_story_v1(
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
 -- The setting is a trusted server transaction gate, not an authorization
 -- boundary against a database principal that can set custom GUCs. No
 -- runtime writer is registered until the worker and human gates qualify.
 IF current_setting('postmill.editorial_live_release_enabled',true) IS DISTINCT FROM 'on'
 OR org IS DISTINCT FROM 'org-modes' OR target IS DISTINCT FROM 'max:-73052031470103' THEN
  RAISE EXCEPTION 'EDITORIAL_LIVE_RELEASE_DISABLED' USING ERRCODE='55000';
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
  'status','recorded','publishable',false,'dispatch_authorized',false,
  'provider_version',coalesce(i."providerVersion",'v1'));
END $fn$;

-- Native preflight/post-claim read, not a send grant. No runtime caller yet.
CREATE FUNCTION public.postmill_read_live_release_photo_v1(org text,pub text,occ text,started boolean DEFAULT false,operation text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE r "EditorialRelease"%ROWTYPE; src "Post"%ROWTYPE; dst "Post"%ROWTYPE;
 o "MaxDeliveryOccurrence"%ROWTYPE; journal "MaxDeliveryAttempt"%ROWTYPE; ctx jsonb; st jsonb; media jsonb; pin jsonb;
 integ "Integration"%ROWTYPE; target constant text:='max:-73052031470103';
BEGIN
 IF current_setting('postmill.editorial_live_release_worker_enabled',true) IS DISTINCT FROM 'on'
 OR org IS DISTINCT FROM 'org-modes'
 OR (pub ~ '^[0-9a-f]{32}$' AND occ ~ '^max_[0-9a-f]{64}$' AND started IS NOT NULL
 AND ((NOT started AND operation IS NULL) OR (started AND operation IS NOT NULL))) IS NOT TRUE
 THEN RETURN NULL; END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
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
 IF NOT FOUND OR (dst.state=CASE WHEN started THEN 'PUBLISHING'::"State" ELSE 'QUEUE'::"State" END AND dst."deletedAt" IS NULL
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
 IF NOT FOUND OR (o.state=CASE WHEN started THEN 'STARTED' ELSE 'READY' END AND o.attempt=CASE WHEN started THEN 1 ELSE 0 END AND o."parentId" IS NULL
 AND o."scheduledAt"=dst."publishDate"
 AND o."scheduledAt"<=clock_timestamp() AND o.fingerprint ~ '^[0-9a-f]{64}$') IS NOT TRUE
 THEN RETURN NULL; END IF;
 IF started THEN
  SELECT * INTO journal FROM "MaxDeliveryAttempt" WHERE "occurrenceId"=occ AND number=1;
  IF NOT FOUND OR (journal.state='STARTED'
   AND operation ~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   AND journal.target->>'storygoOperationId'=operation
   AND journal.target->>'storyPhotoSha256'=media->>'sha256'
   AND journal.target->>'content'=dst.content
   AND journal.target->>'textSha256'=encode(sha256(convert_to(dst.content,'UTF8')),'hex')
   AND journal.target->>'integrationId'=integ.id
   AND journal.target->>'chatId'=target
   AND journal.target->>'version'=coalesce(integ."providerVersion",'v1')
   AND journal.target->'providerConfigId'=coalesce(to_jsonb(integ."providerConfigId"),'null'::jsonb)
   AND journal.target->>'tokenHash'=dst."maxTarget"->>'tokenHash'
   AND dst."maxDelivery"=jsonb_build_object('occurrenceId',occ,'state','STARTED','attempt',1)
   AND (SELECT count(*) FROM "MaxDeliveryAttempt" WHERE "occurrenceId"=occ)=1
  ) IS NOT TRUE THEN RETURN NULL; END IF;
 END IF;
 -- Fingerprint equality remains the existing native begin() responsibility.
 RETURN jsonb_build_object('publication_post_id',pub,'source_post_id',src.id,
  'occurrence_id',occ,'attempt',1,'confirmed_seq',r."confirmedSeq",
  'target',target,'fingerprint',o.fingerprint,'request',jsonb_build_object('org_id',org,'task_id',src."editorialTaskId",
    'channel_id',ctx->'scope'->>'channel_id','state',st),
  'pin',pin,'media',media,'dispatch_authorized',false,'publishable',false);
END $fn$;


REVOKE ALL ON FUNCTION public.postmill_release_live_editorial_story_v1(text,text,text,text,text,jsonb,jsonb,jsonb,bytea),
 public.postmill_read_live_release_photo_v1(text,text,text,boolean,text) FROM PUBLIC;
COMMIT;
