-- 06B-3A: inactive initial review anchor and durable first decision.
-- SQL functions are trusted invoker persistence boundaries, NOT authentication.
BEGIN;
CREATE TABLE "EditorialReviewAnchor" (
 "postId" TEXT NOT NULL,
 snapshot JSONB NOT NULL,
 "snapshotHash" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EditorialReviewAnchor_pkey" PRIMARY KEY ("postId"),
 CONSTRAINT "EditorialReviewAnchor_postId_fkey" FOREIGN KEY ("postId")
  REFERENCES "EditorialDraftReceipt"("postId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "EditorialReviewAnchor_snapshot_integrity" CHECK (
  jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=10000
  AND "snapshotHash"=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'))
);
CREATE TABLE "EditorialDecisionOutbox" (
 "eventId" TEXT NOT NULL,
 "postId" TEXT NOT NULL,
 "commandId" TEXT NOT NULL,
 "expectedSeq" TEXT NOT NULL,
 payload JSONB NOT NULL,
 "payloadHash" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "EditorialDecisionOutbox_pkey" PRIMARY KEY ("eventId"),
 CONSTRAINT "EditorialDecisionOutbox_postId_fkey" FOREIGN KEY ("postId")
  REFERENCES "EditorialReviewAnchor"("postId") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "EditorialDecisionOutbox_payload_integrity" CHECK (
  jsonb_typeof(payload)='object' AND octet_length(payload::text)<=40000
  AND payload->>'event_id' IS NOT DISTINCT FROM "eventId"
  AND payload->>'expected_seq' IS NOT DISTINCT FROM "expectedSeq"
  AND payload->'binding'->>'post_id' IS NOT DISTINCT FROM "postId"
  AND "payloadHash"=encode(sha256(convert_to(payload::text,'UTF8')),'hex'))
);
CREATE UNIQUE INDEX "EditorialDecisionOutbox_postId_commandId_key"
 ON "EditorialDecisionOutbox"("postId","commandId");
CREATE UNIQUE INDEX "EditorialDecisionOutbox_postId_expectedSeq_key"
 ON "EditorialDecisionOutbox"("postId","expectedSeq");
CREATE FUNCTION postmill_editorial_decision_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 RAISE EXCEPTION 'EDITORIAL_DECISION_LEDGER_IMMUTABLE' USING ERRCODE='55000';
END $fn$;
CREATE TRIGGER "EditorialReviewAnchor_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialReviewAnchor"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();
CREATE TRIGGER "EditorialDecisionOutbox_immutable_v1" BEFORE UPDATE OR DELETE ON "EditorialDecisionOutbox"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();

-- Future authenticated transport must fetch/verify the actual Editorial
-- core.start_review state. This SQL checks equality, not remote authenticity.
-- No route, credential, grant, or autonomous invocation in this migration.
CREATE FUNCTION postmill_anchor_editorial_review_v1(s jsonb, task text, target text, remote_state jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; expected jsonb; mode text; pid text; prior jsonb; created boolean:=false;
BEGIN
 -- Reconciliation locks org/task, Post, live Integration/Campaign.
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL THEN RAISE EXCEPTION 'EDITORIAL_DRAFT_NOT_FOUND' USING ERRCODE='55000'; END IF;
 pid:=verified->'receipt'->'binding'->>'post_id'; mode:=verified->'receipt'->>'image_mode';
 expected:=jsonb_build_object('binding',verified->'receipt'->'binding',
  'seq','0','image_mode',mode,'text_status','pending','text_request_id',NULL,
  'text',verified->'receipt'->'text','image',NULL,'image_compatible',false,
  'image_intent',CASE WHEN mode IN ('automatic','after_text_approval') THEN 'initial:1' ELSE NULL END,
  'rejected',false,'final_approved',false,'dispatch_authorized',false,'publishable',false);
 IF remote_state IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'EDITORIAL_INITIAL_STATE_MISMATCH' USING ERRCODE='55000'; END IF;
 SELECT snapshot INTO prior FROM "EditorialReviewAnchor" WHERE "postId"=pid;
 IF FOUND THEN
  IF prior IS DISTINCT FROM remote_state THEN
   RAISE EXCEPTION 'EDITORIAL_INITIAL_STATE_CONFLICT' USING ERRCODE='55000'; END IF;
 ELSE
  INSERT INTO "EditorialReviewAnchor"("postId",snapshot,"snapshotHash")
  VALUES(pid,remote_state,encode(sha256(convert_to(remote_state::text,'UTF8')),'hex'));
  created:=true;
 END IF;
 -- Only evidence of the initial remote state, never current approval.
 RETURN jsonb_build_object('created',created,'initial_state',remote_state,
  'dispatch_authorized',false,'publishable',false);
END $fn$;

-- Only a future authenticated human route may call this with actor derived
-- from the verified Postmill session and current org authorization. The
-- command id is the caller's retry key, not the remote event id.
CREATE FUNCTION postmill_queue_editorial_decision_v1(s jsonb, task text, target text, actor text, command jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; anchor jsonb; pid text; action text; feedback text; cmd text;
 old "EditorialDecisionOutbox"%ROWTYPE; ev jsonb; eid text; h text; created boolean:=false;
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
 ELSE
  IF EXISTS(SELECT 1 FROM "EditorialDecisionOutbox" WHERE "postId"=pid) THEN
   RAISE EXCEPTION 'EDITORIAL_DECISION_AWAITING_RECONCILIATION' USING ERRCODE='55000'; END IF;
  IF command->'expected_seq' IS DISTINCT FROM anchor->'seq'
    OR command->'text' IS DISTINCT FROM anchor->'text'
    OR command->'image' IS DISTINCT FROM anchor->'image'
    OR anchor->'binding' IS DISTINCT FROM verified->'receipt'->'binding'
    OR anchor->'text' IS DISTINCT FROM verified->'receipt'->'text' THEN
   RAISE EXCEPTION 'EDITORIAL_STALE_DECISION' USING ERRCODE='55000'; END IF;
  -- Only initial pending-state actions; the remaining contract transitions
  -- require later receipt import/revision synchronization.
  IF action NOT IN ('approve_text','request_text_changes','reject','request_image')
    OR (action='request_image' AND anchor->>'image_mode'<>'manual') THEN
   RAISE EXCEPTION 'EDITORIAL_INITIAL_ACTION_BLOCKED' USING ERRCODE='55000'; END IF;
  IF (action='request_text_changes' AND feedback !~ '[^[:space:]]')
    OR (action<>'request_text_changes' AND feedback<>'') THEN
   RAISE EXCEPTION 'EDITORIAL_FEEDBACK_INVALID' USING ERRCODE='22023'; END IF;
  eid:=gen_random_uuid()::text;
  ev:=jsonb_build_object('schema_version',1,'event_id',eid,'producer','postmill','actor_id',actor,
    'occurred_at',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'binding',anchor->'binding','expected_seq',anchor->'seq','action',action,
    'text',anchor->'text','image',anchor->'image','feedback',feedback,
    'request_id',NULL,'revision_content',NULL);
  h:=encode(sha256(convert_to(ev::text,'UTF8')),'hex');
  INSERT INTO "EditorialDecisionOutbox"("eventId","postId","commandId","expectedSeq",payload,"payloadHash")
   VALUES(eid,pid,cmd,anchor->>'seq',ev,h);
  created:=true;
 END IF;
 RETURN jsonb_build_object('newly_queued',created,'replay',NOT created,'event',ev,'payload_sha256',h,
  'remote_status','unconfirmed','dispatch_authorized',false,'publishable',false);
END $fn$;
REVOKE ALL ON "EditorialReviewAnchor","EditorialDecisionOutbox" FROM PUBLIC;
REVOKE ALL ON FUNCTION postmill_anchor_editorial_review_v1(jsonb,text,text,jsonb),
 postmill_queue_editorial_decision_v1(jsonb,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
