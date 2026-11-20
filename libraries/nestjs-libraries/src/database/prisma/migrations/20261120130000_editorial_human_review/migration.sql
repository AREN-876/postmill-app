-- 06B-4A: session-authorized human review adapter, inactive until explicit
-- Postmill API activation. These invoker functions are persistence boundaries,
-- NOT user authentication; SessionAuth + CSRF + RBAC remain mandatory.
BEGIN;

-- Always derive scope and channel from the immutable native draft receipt.
-- No caller-supplied scope, image/text, channel or actor claim is trusted.
CREATE FUNCTION postmill_read_editorial_human_v1(org text, pid text, task text, target text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s jsonb; draft jsonb; content jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000';
 END IF;
 IF org IS NULL OR org !~ '^[A-Za-z0-9_.:-]{1,200}$'
   OR pid IS NULL OR pid !~ '^[0-9a-f]{32}$'
   OR task IS NULL OR task !~ '^[1-9][0-9]{0,18}$'
   OR (length(task)=19 AND task>'9223372036854775807')
   OR target IS NULL OR length(target) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_INVALID' USING ERRCODE='22023';
 END IF;
 -- Same lock order as original 06B: task advisory lock, then Post/target.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,task)::text,0));
 SELECT r.request->'scope',r.request->'content' INTO s,content
 FROM "Post" p JOIN "EditorialDraftReceipt" r ON r."postId"=p.id
 WHERE p.id=pid AND p."organizationId"=org AND p."editorialTaskId"=task
  AND r.request->'scope'->>'org_id'=org
  AND r.request->'scope'->'is_test'='true'::jsonb
  AND r."targetSnapshot"->>'internalId'=target
 FOR SHARE OF p;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- This rechecks native frozen DRAFT, receipt, image mode, integration,
 -- campaign, unchanged MAX target token and absence of child posts.
 draft:=postmill_read_editorial_review_v1(s,task,target);
 IF draft IS NULL OR draft->'receipt'->'binding'->>'post_id' IS DISTINCT FROM pid
  OR draft->'receipt'->'binding'->>'org_id' IS DISTINCT FROM org
  OR draft->'receipt'->'binding'->>'task_id' IS DISTINCT FROM task THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_BINDING_CHANGED' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('post_id',pid,'task_id',task,'content',content,
   'receipt',draft->'receipt','review',draft->'review',
   'review_acknowledged',draft->'review_acknowledged',
   'remote_current_verified',false,'dispatch_authorized',false,'publishable',false);
END $fn$;

-- The submitted command has ONLY an idempotency key, sequence, action and
-- feedback. Canonical text/image hashes are taken from the DB under the same
-- advisory lock; retries use their original immutable event snapshot.
CREATE FUNCTION postmill_queue_editorial_human_v1(
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
  AND cmd->>'action' IN ('approve_text','request_text_changes','reject','request_image')
  AND jsonb_typeof(cmd->'feedback')='string'
  AND length(cmd->>'feedback')<=4000 AND octet_length(cmd->>'feedback')<=16000
  AND ((cmd->>'action'='request_text_changes' AND cmd->>'feedback' ~ '[^[:space:]]')
    OR (cmd->>'action'<>'request_text_changes' AND cmd->>'feedback'=''))) IS NOT TRUE THEN
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
REVOKE ALL ON FUNCTION postmill_read_editorial_human_v1(text,text,text,text),
 postmill_queue_editorial_human_v1(text,text,text,text,text,jsonb) FROM PUBLIC;
COMMIT;
