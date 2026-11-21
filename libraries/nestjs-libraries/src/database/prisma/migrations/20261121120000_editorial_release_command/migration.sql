-- 09B: One explicit release of an approved three-part StoryGo artifact.
-- Original managed editorial DRAFT stays frozen forever; the native publisher
-- receives one separate immutable-text Post. This avoids weakening 06A.
-- Disabled at the HTTP layer unless separately registered and scoped to a test org.
BEGIN;

CREATE TABLE "EditorialRelease" (
  "sourcePostId" TEXT NOT NULL PRIMARY KEY,
  "publicationPostId" TEXT NOT NULL UNIQUE,
  "commandId" TEXT NOT NULL,
  mode TEXT NOT NULL,
  "publishAt" TIMESTAMP(3) NOT NULL,
  "actorId" TEXT NOT NULL,
  "confirmedSeq" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialRelease_source_fkey" FOREIGN KEY ("sourcePostId")
    REFERENCES "Post"(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "EditorialRelease_publication_fkey" FOREIGN KEY ("publicationPostId")
    REFERENCES "Post"(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "EditorialRelease_command_check" CHECK (
    "commandId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND mode IN ('publish_now','queue')
    AND "actorId" ~ '^[A-Za-z0-9_.:-]{1,200}$'
    AND "confirmedSeq" ~ '^[1-9][0-9]{0,18}$'
  )
);

CREATE FUNCTION postmill_editorial_release_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 RAISE EXCEPTION 'EDITORIAL_RELEASE_IMMUTABLE' USING ERRCODE='55000';
END $fn$;
CREATE TRIGGER "EditorialRelease_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialRelease"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_release_immutable_v1();

-- The published copy may undergo only existing native worker bookkeeping.
-- Content, settings (all three parts), target, schedule and approval are frozen.
-- Legacy edit/reschedule/delete routes cannot mutate an authorized artifact.
CREATE FUNCTION postmill_editorial_publication_fence_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF EXISTS (SELECT 1 FROM public."EditorialRelease" r
            WHERE r."publicationPostId"=OLD.id) THEN
  IF TG_OP='DELETE' THEN
   RAISE EXCEPTION 'EDITORIAL_PUBLICATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(NEW)-ARRAY[
      'state','releaseId','releaseURL','error','maxDelivery','updatedAt',
      'commentCount','lastViews','lastLikes','lastComments'
     ]) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY[
      'state','releaseId','releaseURL','error','maxDelivery','updatedAt',
      'commentCount','lastViews','lastLikes','lastComments'
     ])
   OR NEW.state NOT IN ('QUEUE','PUBLISHING','PUBLISHED','ERROR')
   OR (OLD.state='PUBLISHED' AND NEW.state<>'PUBLISHED')
   OR (OLD.state='ERROR' AND NEW.state<>'ERROR') THEN
   RAISE EXCEPTION 'EDITORIAL_PUBLICATION_IMMUTABLE' USING ERRCODE='55000';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $fn$;
CREATE TRIGGER "Post_editorial_publication_fence_v1"
 BEFORE UPDATE OR DELETE ON "Post" FOR EACH ROW
 EXECUTE FUNCTION postmill_editorial_publication_fence_v1();

-- A full release is one transactional operation: verify signed Editorial
-- decision receipt and frozen native artifact, then create ONE native story
-- Post plus its immutable source→publication association. No MAX call here.
CREATE FUNCTION postmill_release_editorial_story_v1(
 org text, pid text, task text, target text, actor text, command jsonb
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE
 v jsonb; review jsonb; confirmed jsonb; receipt jsonb; s jsonb;
 src public."Post"%ROWTYPE; i public."Integration"%ROWTYPE; prior public."EditorialRelease"%ROWTYPE;
 pubid text; timeutc timestamp(3); at_instant timestamptz;
 cmd text; action text; requested_at text; times jsonb; current_target jsonb;
 utc_minute int; created_at timestamptz:=clock_timestamp();
BEGIN
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

 SELECT * INTO prior FROM public."EditorialRelease" r WHERE r."sourcePostId"=pid;
 IF FOUND THEN
  -- The original release is the only valid result; a retry never creates a
  -- second publication or another dispatch even after a lost HTTP response.
  IF prior."commandId" IS DISTINCT FROM cmd
    OR prior.mode IS DISTINCT FROM action
    OR (action='queue' AND to_char(prior."publishAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
         IS DISTINCT FROM regexp_replace(requested_at, '[.]000Z
   RAISE EXCEPTION 'EDITORIAL_RELEASE_ALREADY_EXISTS' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('created',false,'source_post_id',pid,
   'publication_post_id',prior."publicationPostId",'mode',prior.mode,
   'publish_at',to_char(prior."publishAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'status','already_recorded','publishable',false);
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
  AND confirmed->>'image_mode'='disabled'
  AND confirmed->'image'='null'::jsonb
  AND confirmed->'dispatch_authorized'='false'::jsonb
  AND confirmed->'publishable'='false'::jsonb
  AND confirmed->>'seq' ~ '^[1-9][0-9]{0,18}$'
  AND EXISTS(
   SELECT 1 FROM public."EditorialDecisionOutbox" o
   JOIN public."EditorialDecisionResult" r ON r."eventId"=o."eventId"
   WHERE o."postId"=pid AND o."eventId"=review->>'latest_event_id'
    AND o.payload->>'action'='approve_text'
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

 pubid:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO public."Post"(
   id,"organizationId","integrationId","campaignId","group",state,
   "publishDate",content,settings,image,"creationMethod","updatedAt",
   "approvalStatus","approvedById","approvedAt","maxScheduleRevision","maxTarget"
 ) VALUES(
   pubid,org,i.id,src."campaignId",'edx-release-'||pubid,'QUEUE',
   timeutc,src.content,src.settings,src.image,'API',now(),
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
  'status','queued_for_native_dispatch','publishable',false,
  'provider_version',coalesce(i."providerVersion",'v1'));
END $fn$;

REVOKE ALL ON FUNCTION postmill_release_editorial_story_v1(
 text,text,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
, 'Z')) THEN
   RAISE EXCEPTION 'EDITORIAL_RELEASE_ALREADY_EXISTS' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('created',false,'source_post_id',pid,
   'publication_post_id',prior."publicationPostId",'mode',prior.mode,
   'publish_at',to_char(prior."publishAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'status','already_recorded','publishable',false);
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
  AND confirmed->>'image_mode'='disabled'
  AND confirmed->'image'='null'::jsonb
  AND confirmed->'dispatch_authorized'='false'::jsonb
  AND confirmed->'publishable'='false'::jsonb
  AND confirmed->>'seq' ~ '^[1-9][0-9]{0,18}$'
  AND EXISTS(
   SELECT 1 FROM public."EditorialDecisionOutbox" o
   JOIN public."EditorialDecisionResult" r ON r."eventId"=o."eventId"
   WHERE o."postId"=pid AND o."eventId"=review->>'latest_event_id'
    AND o.payload->>'action'='approve_text'
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

 pubid:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO public."Post"(
   id,"organizationId","integrationId","campaignId","group",state,
   "publishDate",content,settings,image,"creationMethod","updatedAt",
   "approvalStatus","approvedById","approvedAt","maxScheduleRevision","maxTarget"
 ) VALUES(
   pubid,org,i.id,src."campaignId",'edx-release-'||pubid,'QUEUE',
   timeutc,src.content,src.settings,src.image,'API',now(),
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
  'status','queued_for_native_dispatch','publishable',false);
END $fn$;

REVOKE ALL ON FUNCTION postmill_release_editorial_story_v1(
 text,text,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
