-- 06B-3B: inactive receipt import and confirmed same-artifact state.
BEGIN;
CREATE TABLE "EditorialDecisionResult" (
 "eventId" TEXT NOT NULL,
 outcome JSONB NOT NULL,
 "outcomeHash" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EditorialDecisionResult_pkey" PRIMARY KEY ("eventId"),
 CONSTRAINT "EditorialDecisionResult_eventId_fkey" FOREIGN KEY ("eventId")
  REFERENCES "EditorialDecisionOutbox"("eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "EditorialDecisionResult_integrity" CHECK (
  jsonb_typeof(outcome)='object' AND octet_length(outcome::text)<=20000
  AND "outcomeHash"=encode(sha256(convert_to(outcome::text,'UTF8')),'hex'))
);
CREATE TRIGGER "EditorialDecisionResult_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialDecisionResult"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();

-- Independent subset of the exact Editorial-013 pure transition. No image
-- artifact or revised text install allowed until native revision support.
CREATE FUNCTION postmill_editorial_next_state_v1(before_state jsonb, ev jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE next_state jsonb; a text; mode text; seq text;
BEGIN
 IF (before_state->'rejected'='false'::jsonb
 AND before_state->'image'='null'::jsonb AND before_state->'image_compatible'='false'::jsonb
 AND before_state->'dispatch_authorized'='false'::jsonb AND before_state->'publishable'='false'::jsonb
 AND ev->'binding'=before_state->'binding' AND ev->'text'=before_state->'text'
 AND ev->'image'=before_state->'image' AND ev->'expected_seq'=before_state->'seq'
 AND ev->>'producer'='postmill' AND ev->'request_id'='null'::jsonb
 AND ev->'revision_content'='null'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
 seq:=before_state->>'seq';
 IF seq IS NULL OR seq !~ '^(0|[1-9][0-9]{0,18})$' THEN RETURN NULL; END IF;
 IF seq::numeric>=9223372036854775807 THEN RETURN NULL; END IF;
 a:=ev->>'action'; mode:=before_state->>'image_mode';
 IF (mode IN ('automatic','after_text_approval','manual','disabled')
 AND jsonb_typeof(ev->'feedback')='string'
 AND ((a='request_text_changes' AND ev->>'feedback' ~ '[^[:space:]]')
   OR (a<>'request_text_changes' AND ev->>'feedback'=''))) IS NOT TRUE THEN RETURN NULL; END IF;
 next_state:=before_state||jsonb_build_object('seq',(seq::bigint+1)::text);
 CASE a
 WHEN 'approve_text' THEN
  IF before_state->>'text_status'<>'pending' THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('text_status','approved','final_approved',mode='disabled');
 WHEN 'request_text_changes' THEN
  IF before_state->>'text_status'='changes_requested' THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('text_status','changes_requested','text_request_id',ev->>'event_id',
   'final_approved',false,'image_intent',NULL);
 WHEN 'request_image' THEN
  IF (before_state->>'text_status'<>'changes_requested' AND mode<>'disabled'
    AND (mode<>'after_text_approval' OR before_state->>'text_status'='approved')
    AND before_state->'image_intent'='null'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('image_intent','event:'||(ev->>'event_id'),'final_approved',false);
 WHEN 'reject' THEN
  next_state:=next_state||jsonb_build_object('rejected',true,'text_status','pending','text_request_id',NULL,
   'image_intent',NULL,'final_approved',false);
 ELSE RETURN NULL;
 END CASE;
 RETURN next_state;
END $fn$;

-- Internal helper called under the existing org/task advisory lock. The
-- last confirmed snapshot is historical evidence, NOT a live remote read.
CREATE FUNCTION postmill_editorial_confirmed_v1(pid text) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE last_state jsonb; latest_event text; latest_outcome jsonb; review_status text:='idle';
BEGIN
 SELECT snapshot INTO last_state FROM "EditorialReviewAnchor" WHERE "postId"=pid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT r.outcome->'state' INTO latest_outcome
 FROM "EditorialDecisionOutbox" o JOIN "EditorialDecisionResult" r ON r."eventId"=o."eventId"
 WHERE o."postId"=pid AND r.outcome->>'status'='accepted'
 ORDER BY o."expectedSeq"::bigint DESC LIMIT 1;
 IF FOUND THEN last_state:=latest_outcome; END IF;
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

-- The actual 013 response lacks event_id/hash. Future authenticated transport
-- MUST bind the response to the submitted exact outbox event and its digest
-- (or authoritative remote event-log read), never caller-supplied UI values.
CREATE FUNCTION postmill_import_editorial_result_v1(s jsonb, task text, target text,
 eid text, event_hash text, reply jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; pid text; evt "EditorialDecisionOutbox"%ROWTYPE; prior jsonb; next_state jsonb;
 existing jsonb; normalized jsonb; h text; created boolean:=false;
BEGIN
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL THEN RAISE EXCEPTION 'EDITORIAL_DRAFT_NOT_FOUND' USING ERRCODE='55000'; END IF;
 pid:=verified->'receipt'->'binding'->>'post_id';
 SELECT * INTO evt FROM "EditorialDecisionOutbox" WHERE "postId"=pid AND "eventId"=eid;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_EVENT_NOT_FOUND' USING ERRCODE='55000'; END IF;
 IF event_hash IS DISTINCT FROM evt."payloadHash" THEN
  RAISE EXCEPTION 'EDITORIAL_EVENT_HASH_MISMATCH' USING ERRCODE='55000'; END IF;
 IF (jsonb_typeof(reply)='object' AND octet_length(reply::text)<=20000
  AND reply ?& ARRAY['status','reason','state','dispatch_authorized','publishable','newly_applied','replay']
  AND reply-ARRAY['status','reason','state','dispatch_authorized','publishable','newly_applied','replay']='{}'::jsonb
  AND jsonb_typeof(reply->'status')='string' AND reply->>'status' IN ('accepted','rejected')
  AND jsonb_typeof(reply->'state')='object' AND reply->'dispatch_authorized'='false'::jsonb
  AND reply->'publishable'='false'::jsonb AND jsonb_typeof(reply->'replay')='boolean'
  AND jsonb_typeof(reply->'newly_applied')='boolean'
  AND ((reply->>'status'='accepted' AND reply->'reason'='null'::jsonb
       AND ((reply->'newly_applied'='true'::jsonb AND reply->'replay'='false'::jsonb)
         OR (reply->'newly_applied'='false'::jsonb AND reply->'replay'='true'::jsonb)))
    OR (reply->>'status'='rejected' AND jsonb_typeof(reply->'reason')='string'
       AND length(reply->>'reason') BETWEEN 1 AND 100 AND reply->'newly_applied'='false'::jsonb))) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_RESULT' USING ERRCODE='22023'; END IF;
 normalized:=reply-ARRAY['newly_applied','replay'];
 h:=encode(sha256(convert_to(normalized::text,'UTF8')),'hex');
 SELECT outcome INTO existing FROM "EditorialDecisionResult" WHERE "eventId"=eid;
 IF FOUND THEN
  IF existing IS DISTINCT FROM normalized THEN
   RAISE EXCEPTION 'EDITORIAL_RESULT_CONFLICT' USING ERRCODE='55000'; END IF;
 ELSE
  -- No skipping the outstanding event or accepting a future/stale snapshot.
  prior:=postmill_editorial_confirmed_v1(pid);
  IF prior->>'status' IS DISTINCT FROM 'pending' OR prior->>'latest_event_id' IS DISTINCT FROM eid THEN
   RAISE EXCEPTION 'EDITORIAL_RESULT_NOT_PENDING' USING ERRCODE='55000'; END IF;
  prior:=prior->'last_confirmed_state';
  next_state:=postmill_editorial_next_state_v1(prior,evt.payload);
  IF next_state IS NULL OR
    (reply->>'status'='accepted' AND reply->'state' IS DISTINCT FROM next_state) OR
    (reply->>'status'='rejected' AND reply->'state' IS DISTINCT FROM prior) THEN
   -- Divergent remote state must be reconciled separately. Keep pending,
   -- never turn an unknown result into a failure or an authorization.
   RAISE EXCEPTION 'EDITORIAL_RESULT_STATE_MISMATCH' USING ERRCODE='55000'; END IF;
  INSERT INTO "EditorialDecisionResult"("eventId",outcome,"outcomeHash") VALUES(eid,normalized,h);
  created:=true;
 END IF;
 RETURN jsonb_build_object('newly_recorded',created,'replay',NOT created,'event_id',eid,
  'outcome',normalized,'outcome_sha256',h,'dispatch_authorized',false,'publishable',false);
END $fn$;

CREATE FUNCTION postmill_read_editorial_review_v1(s jsonb, task text, target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; confirmed jsonb;
BEGIN
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL THEN RETURN NULL; END IF;
 confirmed:=postmill_editorial_confirmed_v1(verified->'receipt'->'binding'->>'post_id');
 RETURN jsonb_build_object('receipt',verified->'receipt','review_acknowledged',confirmed IS NOT NULL,
  'review',confirmed,'dispatch_authorized',false,'publishable',false);
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

REVOKE ALL ON "EditorialDecisionResult" FROM PUBLIC;
REVOKE ALL ON FUNCTION postmill_editorial_next_state_v1(jsonb,jsonb),postmill_editorial_confirmed_v1(text),
 postmill_import_editorial_result_v1(jsonb,text,text,text,text,jsonb),
 postmill_read_editorial_review_v1(jsonb,text,text),
 postmill_queue_editorial_decision_v1(jsonb,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
