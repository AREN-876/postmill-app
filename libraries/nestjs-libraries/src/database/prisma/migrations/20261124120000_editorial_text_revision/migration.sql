-- Immutable owner-installed revisions after an accepted return request.
-- The authenticated 015 reader is the only intended server-side caller.
BEGIN;
CREATE TABLE "EditorialTextRevision" (
 "requestEventId" TEXT NOT NULL PRIMARY KEY,
 "postId" TEXT NOT NULL,
 revision INTEGER NOT NULL,
 "installEventId" TEXT NOT NULL,
 proof JSONB NOT NULL,
 "proofHash" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EditorialTextRevision_requestEventId_fkey" FOREIGN KEY ("requestEventId")
   REFERENCES "EditorialDecisionOutbox"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "EditorialTextRevision_postId_fkey" FOREIGN KEY ("postId")
   REFERENCES "EditorialDraftReceipt"("postId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "EditorialTextRevision_shape" CHECK (
  revision>=2 AND jsonb_typeof(proof)='object' AND octet_length(proof::text)<=100000
  AND "proofHash"=encode(sha256(convert_to(proof::text,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX "EditorialTextRevision_postId_revision_key" ON "EditorialTextRevision"("postId",revision);
CREATE UNIQUE INDEX "EditorialTextRevision_installEventId_key" ON "EditorialTextRevision"("installEventId");
CREATE TRIGGER "EditorialTextRevision_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialTextRevision"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();

CREATE FUNCTION postmill_editorial_artifact_v1(pid text, wanted integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE base jsonb; p jsonb; body jsonb;
BEGIN
 SELECT coalesce(i.request,r.request) INTO base
 FROM "EditorialDraftReceipt" r LEFT JOIN "EditorialTextInstall" i ON i."postId"=r."postId"
 WHERE r."postId"=pid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF wanted=1 THEN RETURN base; END IF;
 SELECT x.proof INTO p FROM "EditorialTextRevision" x
 WHERE x."postId"=pid AND (wanted IS NULL OR x.revision=wanted)
 ORDER BY x.revision DESC LIMIT 1;
 IF NOT FOUND THEN
  IF wanted IS NULL THEN RETURN base; END IF;
  RETURN NULL;
 END IF;
 body:=p->'install_event'->'revision_content';
 RETURN base||jsonb_build_object('text',p->'state'->'text','content',body,
   'firstPart',(body->>'title')||E'\n\n'||(body->'parts'->>0),
   'continuationText',(body->'parts'->>1)||E'\n────────────────────────\n'||(body->'parts'->>2));
END $fn$;


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
 SELECT o."eventId",r.outcome INTO latest_event,latest_outcome
 FROM "EditorialDecisionOutbox" o LEFT JOIN "EditorialDecisionResult" r ON r."eventId"=o."eventId"
 WHERE o."postId"=pid ORDER BY o."expectedSeq"::bigint DESC LIMIT 1;
 IF FOUND THEN
  review_status:=CASE WHEN latest_outcome IS NULL THEN 'pending'
   WHEN latest_outcome->>'status'='rejected' THEN 'rejected' ELSE 'idle' END;
 END IF;
 RETURN jsonb_build_object('last_confirmed_state',last_state,'status',review_status,
  'latest_event_id',latest_event,'remote_current_verified',false,
  'dispatch_authorized',false,'publishable',false);
END $fn$;

CREATE OR REPLACE FUNCTION postmill_editorial_draft_fence_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE v_initial jsonb; v_final jsonb; rev integer; req text; confirmed jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."editorialTaskId" IS NOT NULL THEN
   RAISE EXCEPTION 'EDITORIAL_MANAGED_DRAFT_FROZEN' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW."editorialTaskId",NEW."editorialProfileRef") IS DISTINCT FROM
     (OLD."editorialTaskId",OLD."editorialProfileRef") THEN
   RAISE EXCEPTION 'EDITORIAL_BINDING_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF OLD."editorialTaskId" IS NOT NULL AND
    (to_jsonb(NEW)-ARRAY['updatedAt','commentCount','lastViews','lastLikes','lastComments'])
      IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['updatedAt','commentCount','lastViews','lastLikes','lastComments']) THEN
   -- No session-variable bypass: the immutable installation ledger is the
   -- only permission for this exact one-time native content transition.
   IF (to_jsonb(NEW)-ARRAY['content','settings','updatedAt','commentCount','lastViews','lastLikes','lastComments'])
        IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['content','settings','updatedAt','commentCount','lastViews','lastLikes','lastComments'])
      AND (NEW.content,NEW.settings) IS DISTINCT FROM (OLD.content,OLD.settings)
      AND NOT EXISTS (SELECT 1 FROM "EditorialReviewAnchor" a WHERE a."postId"=OLD.id)
      AND NOT EXISTS (SELECT 1 FROM "EditorialDecisionOutbox" o WHERE o."postId"=OLD.id)
      AND NOT EXISTS (SELECT 1 FROM "EditorialRelease" r WHERE r."sourcePostId"=OLD.id)
   THEN
     SELECT r.request,i.request INTO v_initial,v_final
     FROM "EditorialDraftReceipt" r JOIN "EditorialTextInstall" i
       ON i."postId"=r."postId"
     WHERE r."postId"=OLD.id;
     IF FOUND AND
       OLD.content IS NOT DISTINCT FROM v_initial->>'firstPart' AND
       OLD.settings::jsonb IS NOT DISTINCT FROM jsonb_build_object(
         '__type','max','mode','story','continuationText',v_initial->>'continuationText') AND
       v_final->'scope' IS NOT DISTINCT FROM v_initial->'scope' AND
       v_final->>'task_id' IS NOT DISTINCT FROM OLD."editorialTaskId" AND
       NEW.content IS NOT DISTINCT FROM v_final->>'firstPart' AND
       NEW.settings::jsonb IS NOT DISTINCT FROM jsonb_build_object(
         '__type','max','mode','story','continuationText',v_final->>'continuationText')
     THEN RETURN NEW; END IF;
   END IF;
   -- Only a transition backed by the latest verified immutable revision.
   IF (to_jsonb(NEW)-ARRAY['content','settings','updatedAt','commentCount','lastViews','lastLikes','lastComments'])
        IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['content','settings','updatedAt','commentCount','lastViews','lastLikes','lastComments'])
      AND NOT EXISTS (SELECT 1 FROM "EditorialRelease" r WHERE r."sourcePostId"=OLD.id)
   THEN
    SELECT revision,"requestEventId" INTO rev,req FROM "EditorialTextRevision"
    WHERE "postId"=OLD.id ORDER BY revision DESC LIMIT 1;
    IF FOUND THEN
     v_initial:=postmill_editorial_artifact_v1(OLD.id,rev-1);
     v_final:=postmill_editorial_artifact_v1(OLD.id,rev);
     confirmed:=postmill_editorial_confirmed_v1(OLD.id);
     IF (confirmed->>'status'='idle' AND confirmed->>'latest_event_id'=req
       AND confirmed->'last_confirmed_state'->'text'=v_final->'text'
       AND confirmed->'last_confirmed_state'->>'text_status'='pending'
       AND confirmed->'last_confirmed_state'->'final_approved'='false'::jsonb
       AND confirmed->'last_confirmed_state'->'rejected'='false'::jsonb
       AND OLD.content=v_initial->>'firstPart'
       AND OLD.settings::jsonb=jsonb_build_object('__type','max','mode','story',
          'continuationText',v_initial->>'continuationText')
       AND NEW.content=v_final->>'firstPart'
       AND NEW.settings::jsonb=jsonb_build_object('__type','max','mode','story',
          'continuationText',v_final->>'continuationText')) IS TRUE THEN RETURN NEW; END IF;
    END IF;
   END IF;
   RAISE EXCEPTION 'EDITORIAL_MANAGED_DRAFT_FROZEN' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW."editorialTaskId" IS NOT NULL THEN
  IF NOT EXISTS (
    SELECT 1 FROM public."Integration" i WHERE i.id=NEW."integrationId"
     AND i."organizationId"=NEW."organizationId" AND i."providerIdentifier"='max'
     AND NOT i.disabled AND NOT i."refreshNeeded" AND i."deletedAt" IS NULL)
   OR NOT EXISTS (
    SELECT 1 FROM public."Campaign" c WHERE c.id=NEW."campaignId"
     AND c."organizationId"=NEW."organizationId" AND NOT c.archived AND c."deletedAt" IS NULL)
   OR NEW.settings::jsonb->>'__type' IS DISTINCT FROM 'max'
   OR NEW.settings::jsonb->>'mode' IS DISTINCT FROM 'story' THEN
   RAISE EXCEPTION 'EDITORIAL_BINDING_INVALID' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION postmill_read_editorial_draft_v1(s jsonb, task text, target text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE p "Post"%ROWTYPE; initial jsonb; effective jsonb; snap jsonb;
 current_target jsonb; settings jsonb; installed jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(s->>'org_id',task)::text,0));
 SELECT a.* INTO p FROM "Post" a JOIN "EditorialDraftReceipt" r ON r."postId"=a.id
 WHERE a."organizationId"=s->>'org_id' AND a."editorialTaskId"=task AND r.request->'scope'=s
 FOR SHARE OF a;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT r.request,r."targetSnapshot",i.request INTO initial,snap,installed
 FROM "EditorialDraftReceipt" r LEFT JOIN "EditorialTextInstall" i ON i."postId"=r."postId"
 WHERE r."postId"=p.id;
 effective:=postmill_editorial_artifact_v1(p.id);
 IF effective IS NULL THEN RAISE EXCEPTION 'EDITORIAL_ARTIFACT_MISSING' USING ERRCODE='55000'; END IF;
 current_target:=postmill_check_editorial_target_v1(s,target);
 IF snap IS NULL OR snap IS DISTINCT FROM current_target THEN
  RAISE EXCEPTION 'EDITORIAL_TARGET_CHANGED' USING ERRCODE='55000'; END IF;
 settings:=p.settings::jsonb;
 IF (initial->>'task_id'=task AND initial->'scope'=s
 AND initial->'text'->>'sha256'=encode(sha256(convert_to((initial->'content')::text,'UTF8')),'hex')
 AND (installed IS NULL OR (
   installed->>'task_id'=task AND installed->'scope'=s
   AND (SELECT i."sourceHash" FROM "EditorialTextInstall" i WHERE i."postId"=p.id)=initial->'text'->>'sha256'))
 AND effective->>'task_id'=task AND effective->'scope'=s
 AND ((effective->'text'->>'revision')::int=1 OR
      postmill_editorial_confirmed_v1(p.id)->'last_confirmed_state'->'text'=effective->'text')
 AND p."editorialProfileRef"=s->>'profile_ref' AND p."integrationId"=s->>'integration_id'
 AND p."campaignId"=s->>'campaign_id' AND p."group"='editorial-v1-'||p.id AND p.state='DRAFT'
 AND p."approvalStatus"='pending' AND p."parentPostId" IS NULL AND p."deletedAt" IS NULL
 AND p."intervalInDays" IS NULL AND p."releaseId" IS NULL AND p."releaseURL" IS NULL
 AND p."approvedById" IS NULL AND p."approvedAt" IS NULL AND p."maxScheduleRevision"=0
 AND p.content=effective->>'firstPart' AND p.image='[]'
 AND settings=jsonb_build_object('__type','max','mode','story','continuationText',effective->>'continuationText')
 AND effective->'text'->>'sha256'=encode(sha256(convert_to((effective->'content')::text,'UTF8')),'hex')
 AND NOT EXISTS(SELECT 1 FROM "Post" child WHERE child.id<>p.id
  AND (child."parentPostId"=p.id OR child."group"=p."group"))) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_DRAFT_MISMATCH' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('receipt',jsonb_build_object(
  'schema_version',1,'binding',jsonb_build_object('task_id',task,'profile_ref',s->>'profile_ref',
   'org_id',s->>'org_id','integration_id',s->>'integration_id','post_id',p.id,'group_id',p."group",'is_test',true),
  'channel_id',s->'channel_id','campaign_id',s->>'campaign_id','image_mode',s->'image_mode','text',effective->'text',
  'publishable',false,'dispatch_authorized',false),
  'state','DRAFT','native_verified',true,'review_acknowledged',false);
END $fn$;

CREATE OR REPLACE FUNCTION postmill_read_editorial_human_v1(org text, pid text, task text, target text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s jsonb; draft jsonb; content jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 IF org IS NULL OR org !~ '^[A-Za-z0-9_.:-]{1,200}$'
   OR pid IS NULL OR pid !~ '^[0-9a-f]{32}$'
   OR task IS NULL OR task !~ '^[1-9][0-9]{0,18}$'
   OR (length(task)=19 AND task>'9223372036854775807')
   OR target IS NULL OR length(target) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,task)::text,0));
 SELECT r.request->'scope',postmill_editorial_artifact_v1(p.id)->'content' INTO s,content
 FROM "Post" p JOIN "EditorialDraftReceipt" r ON r."postId"=p.id
 WHERE p.id=pid AND p."organizationId"=org AND p."editorialTaskId"=task
  AND r.request->'scope'->>'org_id'=org
  AND r.request->'scope'->'is_test'='true'::jsonb
  AND r."targetSnapshot"->>'internalId'=target
 FOR SHARE OF p;
 IF NOT FOUND THEN RETURN NULL; END IF;
 draft:=postmill_read_editorial_review_v1(s,task,target);
 IF draft IS NULL OR draft->'receipt'->'binding'->>'post_id' IS DISTINCT FROM pid
  OR draft->'receipt'->'binding'->>'org_id' IS DISTINCT FROM org
  OR draft->'receipt'->'binding'->>'task_id' IS DISTINCT FROM task THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_BINDING_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('post_id',pid,'task_id',task,'content',content,
   'receipt',draft->'receipt','review',draft->'review',
   'review_acknowledged',draft->'review_acknowledged',
   'remote_current_verified',false,'dispatch_authorized',false,'publishable',false);
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

-- Re-derive the entire allowed transition from the local accepted receipt.
CREATE FUNCTION postmill_import_editorial_revision_v1(s jsonb, task text, target text,
 req text, digest text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; pid text; review jsonb; before_state jsonb; after_state jsonb;
 ev jsonb; body jsonb; newref jsonb; seq bigint; rev integer;
 prior "EditorialDecisionOutbox"%ROWTYPE; previous_proof jsonb; h text;
 receipt jsonb; part jsonb; title text;
BEGIN
 IF (s->'is_test'='true'::jsonb AND s->>'image_mode'='disabled'
   AND target='max:-73052031470103'
   AND req ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND digest ~ '^[0-9a-f]{64}$'
   AND jsonb_typeof(p)='object' AND octet_length(p::text)<=100000
   AND p ?& ARRAY['install_event_id','install_payload_sha256','install_event','state','publishable','dispatch_authorized']
   AND p-ARRAY['install_event_id','install_payload_sha256','install_event','state','publishable','dispatch_authorized']='{}'::jsonb
   AND p->'publishable'='false'::jsonb AND p->'dispatch_authorized'='false'::jsonb
   AND jsonb_typeof(p->'install_event_id')='string' AND length(p->>'install_event_id') BETWEEN 1 AND 200
   AND p->>'install_payload_sha256' ~ '^[0-9a-f]{64}$') IS NOT TRUE
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_INVALID' USING ERRCODE='22023'; END IF;
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL THEN RAISE EXCEPTION 'EDITORIAL_DRAFT_NOT_FOUND' USING ERRCODE='55000'; END IF;
 pid:=verified->'receipt'->'binding'->>'post_id';
 SELECT * INTO prior FROM "EditorialDecisionOutbox" WHERE "eventId"=req AND "postId"=pid;
 IF NOT FOUND OR prior."payloadHash" IS DISTINCT FROM digest
    OR prior.payload->>'action' IS DISTINCT FROM 'request_text_changes'
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_REQUEST_MISMATCH' USING ERRCODE='55000'; END IF;
 SELECT outcome INTO receipt FROM "EditorialDecisionResult" WHERE "eventId"=req;
 IF NOT FOUND OR receipt->>'status' IS DISTINCT FROM 'accepted'
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_REQUEST_UNCONFIRMED' USING ERRCODE='55000'; END IF;
 SELECT proof INTO previous_proof FROM "EditorialTextRevision" WHERE "requestEventId"=req;
 IF FOUND THEN
  IF previous_proof IS DISTINCT FROM p THEN RAISE EXCEPTION 'EDITORIAL_REVISION_PROOF_CONFLICT' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('installed',false,'state',p->'state','publishable',false,'dispatch_authorized',false);
 END IF;
 review:=postmill_editorial_confirmed_v1(pid); before_state:=review->'last_confirmed_state';
 IF (review->>'status'='idle' AND review->>'latest_event_id'=req
   AND receipt->'state'=before_state AND before_state->>'text_status'='changes_requested'
   AND before_state->>'text_request_id'=req AND before_state->'text'=verified->'receipt'->'text'
   AND before_state->'binding'=verified->'receipt'->'binding'
   AND before_state->>'image_mode'='disabled' AND before_state->'image'='null'::jsonb
   AND before_state->'final_approved'='false'::jsonb AND before_state->'rejected'='false'::jsonb
   AND NOT EXISTS(SELECT 1 FROM "EditorialRelease" WHERE "sourcePostId"=pid)) IS NOT TRUE
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_NOT_PENDING' USING ERRCODE='55000'; END IF;
 ev:=p->'install_event'; body:=ev->'revision_content';
 IF (jsonb_typeof(ev)='object'
   AND ev ?& ARRAY['schema_version','event_id','producer','actor_id','occurred_at','binding','expected_seq','action','text','image','feedback','request_id','revision_content']
   AND ev-ARRAY['schema_version','event_id','producer','actor_id','occurred_at','binding','expected_seq','action','text','image','feedback','request_id','revision_content']='{}'::jsonb
   AND ev->'schema_version'='1'::jsonb AND ev->>'event_id'=p->>'install_event_id'
   AND ev->>'producer'='operator' AND ev->>'action'='install_text'
   AND jsonb_typeof(ev->'actor_id')='string' AND ev->>'actor_id' ~ '[^[:space:]]' AND length(ev->>'actor_id')<=200
   AND ev->>'occurred_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?Z$'
   AND ev->>'feedback'='' AND ev->>'request_id'=req
   AND ev->'expected_seq'=before_state->'seq'
   AND ev->'binding'=before_state->'binding' AND ev->'text'=before_state->'text' AND ev->'image'=before_state->'image'
   AND p->>'install_payload_sha256'=encode(sha256(convert_to(ev::text,'UTF8')),'hex')
   AND jsonb_typeof(body)='object' AND body ?& ARRAY['title','parts']
   AND body-ARRAY['title','parts']='{}'::jsonb
   AND jsonb_typeof(body->'title')='string' AND jsonb_typeof(body->'parts')='array') IS NOT TRUE
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_PROOF_INVALID' USING ERRCODE='22023'; END IF;
 title:=body->>'title';
 IF title<>btrim(title) OR title !~ '[^[:space:]]' OR length(title)>160 OR title ~ '[[:cntrl:]]'
    OR jsonb_array_length(body->'parts')<>3
    OR length(title||E'\n\n'||(body->'parts'->>0))>4000
    OR title ~ '[<>]' OR position('────────────────────────' in title)>0
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_CONTENT_INVALID' USING ERRCODE='22023'; END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(body->'parts') LOOP
  IF (jsonb_typeof(part)='string' AND (part#>>'{}') ~ '[^[:space:]]'
    AND length(part#>>'{}')<=4000 AND (part#>>'{}') !~ '[<>]'
    AND position('────────────────────────' in (part#>>'{}'))=0) IS NOT TRUE
  THEN RAISE EXCEPTION 'EDITORIAL_REVISION_CONTENT_INVALID' USING ERRCODE='22023'; END IF;
 END LOOP;
 seq:=(before_state->>'seq')::bigint;
 rev:=(before_state->'text'->>'revision')::int;
 IF seq=9223372036854775807 OR rev=2147483647 THEN
  RAISE EXCEPTION 'EDITORIAL_REVISION_LIMIT' USING ERRCODE='55000'; END IF;
 rev:=rev+1;
 newref:=jsonb_build_object('revision',rev,'sha256',encode(sha256(convert_to(body::text,'UTF8')),'hex'));
 after_state:=before_state||jsonb_build_object('seq',(seq+1)::text,'text',newref,
   'text_status','pending','text_request_id',NULL,'image_intent',NULL,'image_compatible',false,'final_approved',false);
 IF p->'state' IS DISTINCT FROM after_state THEN
  RAISE EXCEPTION 'EDITORIAL_REVISION_STATE_MISMATCH' USING ERRCODE='55000'; END IF;
 h:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 INSERT INTO "EditorialTextRevision"("requestEventId","postId",revision,"installEventId",proof,"proofHash")
 VALUES(req,pid,rev,p->>'install_event_id',p,h);
 UPDATE "Post" SET content=title||E'\n\n'||(body->'parts'->>0),
   settings=jsonb_build_object('__type','max','mode','story','continuationText',
       (body->'parts'->>1)||E'\n────────────────────────\n'||(body->'parts'->>2))::text,
   "updatedAt"=now() WHERE id=pid AND state='DRAFT';
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_REVISION_NATIVE_MISMATCH' USING ERRCODE='55000'; END IF;
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL OR verified->'receipt'->'text' IS DISTINCT FROM newref
    OR postmill_editorial_confirmed_v1(pid)->'last_confirmed_state' IS DISTINCT FROM after_state
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_NATIVE_MISMATCH' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('installed',true,'state',after_state,'publishable',false,'dispatch_authorized',false);
END $fn$;
REVOKE ALL ON "EditorialTextRevision" FROM PUBLIC;
REVOKE ALL ON FUNCTION postmill_editorial_artifact_v1(text,integer),
 postmill_import_editorial_revision_v1(jsonb,text,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
