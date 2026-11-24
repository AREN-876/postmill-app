-- 58: exact review transitions for the disposable mock image scope only.
-- No changes to Prisma models, native publishing, or production eligibility.
BEGIN;
CREATE FUNCTION postmill_mock_image_review_scope_v1(s jsonb,target text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
 SELECT (s->>'org_id'='org-modes' AND s->'is_test'='true'::jsonb
  AND s->>'integration_id' LIKE 'mock-review-%'
  AND s->>'image_mode' IN ('automatic','manual','after_text_approval')
  AND target='max:-73052031470103') IS TRUE
$fn$;
REVOKE ALL ON FUNCTION postmill_mock_image_review_scope_v1(jsonb,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION postmill_editorial_next_state_v1(before_state jsonb, ev jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE next_state jsonb; a text; mode text; seq text; allowed boolean; suitable boolean; mock boolean;
BEGIN
 IF (before_state->'rejected'='false'::jsonb
 AND jsonb_typeof(before_state->'image') IN ('null','object')
 AND jsonb_typeof(before_state->'image_compatible')='boolean'
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
 AND ((a IN ('request_text_changes','request_image_changes') AND ev->>'feedback' ~ '[^[:space:]]')
   OR (a NOT IN ('request_text_changes','request_image_changes') AND ev->>'feedback'=''))) IS NOT TRUE THEN RETURN NULL; END IF;
 mock:=(before_state->'binding'->>'org_id'='org-modes'
  AND before_state->'binding'->>'integration_id' LIKE 'mock-review-%'
  AND before_state->'binding'->'is_test'='true'::jsonb AND mode<>'disabled') IS TRUE;
 IF (before_state->'image'<>'null'::jsonb OR a IN ('request_image_changes','confirm_image_reuse','approve_final'))
    AND NOT mock THEN RETURN NULL; END IF;
 IF before_state->'image'='null'::jsonb AND before_state->'image_compatible'<>'false'::jsonb THEN RETURN NULL; END IF;
 allowed:=before_state->>'text_status'<>'changes_requested' AND mode<>'disabled'
     AND (mode<>'after_text_approval' OR before_state->>'text_status'='approved');
 suitable:=before_state->'image'<>'null'::jsonb AND before_state->'image_compatible'='true'::jsonb;
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
  IF (allowed AND NOT suitable AND before_state->'image_intent'='null'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('image_intent','event:'||(ev->>'event_id'),'final_approved',false);
 WHEN 'request_image_changes' THEN
  IF (allowed AND before_state->'image'<>'null'::jsonb AND before_state->'image_intent'='null'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('image_intent','event:'||(ev->>'event_id'),'image_compatible',false,'final_approved',false);
 WHEN 'confirm_image_reuse' THEN
  IF (allowed AND before_state->'image'<>'null'::jsonb AND NOT suitable AND before_state->'image_intent'='null'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('image_compatible',true,'final_approved',false);
 WHEN 'approve_final' THEN
  IF (mode<>'disabled' AND before_state->>'text_status'='approved' AND before_state->'final_approved'='false'::jsonb
      AND suitable AND before_state->'image_intent'='null'::jsonb) IS NOT TRUE THEN RETURN NULL; END IF;
  next_state:=next_state||jsonb_build_object('final_approved',true);
 WHEN 'reject' THEN
  next_state:=next_state||jsonb_build_object('rejected',true,'text_status','pending','text_request_id',NULL,
   'image_intent',NULL,'final_approved',false);
 ELSE RETURN NULL;
 END CASE;
 RETURN next_state;
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
  IF anchor->'image'<>'null'::jsonb AND
    (postmill_mock_image_context_v1(s->>'org_id',pid,task,target)->'media' IS NULL
     OR jsonb_typeof(postmill_mock_image_context_v1(s->>'org_id',pid,task,target)->'media')<>'object') THEN
   RAISE EXCEPTION 'EDITORIAL_IMAGE_MEDIA_MISMATCH' USING ERRCODE='55000'; END IF;
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

CREATE OR REPLACE FUNCTION postmill_queue_editorial_human_v1(
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
 result:=postmill_queue_editorial_decision_v1(
  (SELECT r.request->'scope' FROM "EditorialDraftReceipt" r WHERE r."postId"=pid),
  task,target,actor,payload);
 -- Never surface an unverified remote outcome as human approval.
 RETURN jsonb_build_object('status','queued/unconfirmed',
  'event_id',result->'event'->>'event_id',
  'newly_queued',result->'newly_queued','replay',result->'replay',
  'dispatch_authorized',false,'publishable',false);
END $fn$;

CREATE OR REPLACE FUNCTION postmill_import_editorial_revision_v1(s jsonb, task text, target text,
 req text, digest text, p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE verified jsonb; pid text; review jsonb; before_state jsonb; after_state jsonb;
 ev jsonb; body jsonb; newref jsonb; seq bigint; rev integer;
 prior "EditorialDecisionOutbox"%ROWTYPE; previous_proof jsonb; h text;
 receipt jsonb; part jsonb; revision_title text;
BEGIN
 IF (s->'is_test'='true'::jsonb AND (s->>'image_mode'='disabled' OR postmill_mock_image_review_scope_v1(s,target))
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
   AND before_state->>'image_mode'=s->>'image_mode'
   AND (before_state->'image'='null'::jsonb OR postmill_mock_image_review_scope_v1(s,target))
   AND before_state->'final_approved'='false'::jsonb AND before_state->'rejected'='false'::jsonb
   AND NOT EXISTS(SELECT 1 FROM "EditorialRelease" WHERE "sourcePostId"=pid)) IS NOT TRUE
 THEN RAISE EXCEPTION 'EDITORIAL_REVISION_NOT_PENDING' USING ERRCODE='55000'; END IF;
 IF before_state->'image'<>'null'::jsonb AND jsonb_typeof(postmill_mock_image_context_v1(s->>'org_id',pid,task,target)->'media') IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'EDITORIAL_IMAGE_MEDIA_MISMATCH' USING ERRCODE='55000'; END IF;
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
 revision_title:=body->>'title';
 IF revision_title<>btrim(revision_title) OR revision_title !~ '[^[:space:]]' OR length(revision_title)>160 OR revision_title ~ '[[:cntrl:]]'
    OR jsonb_array_length(body->'parts')<>3
    OR length(revision_title||E'\n\n'||(body->'parts'->>0))>4000
    OR revision_title ~ '[<>]' OR position('────────────────────────' in revision_title)>0
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
   'text_status','pending','text_request_id',NULL,'image_intent',CASE WHEN before_state->'image'='null'::jsonb
    AND before_state->>'image_mode' IN ('automatic','after_text_approval') THEN 'initial:'||rev::text END,
   'image_compatible',false,'final_approved',false);
 IF p->'state' IS DISTINCT FROM after_state THEN
  RAISE EXCEPTION 'EDITORIAL_REVISION_STATE_MISMATCH' USING ERRCODE='55000'; END IF;
 h:=encode(sha256(convert_to(p::text,'UTF8')),'hex');
 INSERT INTO "EditorialTextRevision"("requestEventId","postId",revision,"installEventId",proof,"proofHash")
 VALUES(req,pid,rev,p->>'install_event_id',p,h);
 UPDATE "Post" SET content=revision_title||E'\n\n'||(body->'parts'->>0),
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
COMMIT;
