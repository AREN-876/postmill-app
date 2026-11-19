\set ON_ERROR_STOP on
-- Derived from the exact Editorial-013 snapshot/event contract; not an
-- authenticated remote response. No real editor/account/provider involved.
CREATE FUNCTION pg_temp.initial_review(verified jsonb) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object(
 'binding',verified->'receipt'->'binding','seq','0','image_mode',verified->'receipt'->'image_mode',
 'text_status','pending','text_request_id',NULL,'text',verified->'receipt'->'text',
 'image',NULL,'image_compatible',false,'image_intent',
 CASE WHEN verified->'receipt'->>'image_mode' IN ('automatic','after_text_approval') THEN 'initial:1' END,
 'rejected',false,'final_approved',false,'dispatch_authorized',false,'publishable',false)
$$;
CREATE FUNCTION pg_temp.decision(snap jsonb, cmd text, action text, notes text DEFAULT '') RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('command_id',cmd,'expected_seq',snap->'seq',
 'action',action,'text',snap->'text','image',snap->'image','feedback',notes)
$$;
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('180'); s jsonb:=p->'scope';
 snap jsonb; rec jsonb; again jsonb; cmd jsonb; ev jsonb; pid text; bad jsonb;
 key1 text:='11111111-1111-4111-8111-111111111111';
 key2 text:='22222222-2222-4222-8222-222222222222';
BEGIN
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
 pid:=snap->'binding'->>'post_id';
 cmd:=pg_temp.decision(snap,key1,'request_text_changes','Уточнить обстоятельства 😀');
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',cmd);
  RAISE EXCEPTION 'decision without anchor';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_REVIEW_NOT_ACKNOWLEDGED' THEN RAISE; END IF; END;
 FOREACH bad IN ARRAY ARRAY[
  jsonb_set(snap,'{seq}','"1"'),jsonb_set(snap,'{text,sha256}',to_jsonb(repeat('0',64))),
  jsonb_set(snap,'{binding,org_id}','"org-b"'),jsonb_set(snap,'{image_intent}','null'),
  jsonb_set(snap,'{final_approved}','true'),snap||'{"extra":true}'::jsonb
 ] LOOP
 BEGIN PERFORM postmill_anchor_editorial_review_v1(s,'180','test-channel',bad);
  RAISE EXCEPTION 'bad anchor accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_INITIAL_STATE_MISMATCH' THEN RAISE; END IF; END;
 END LOOP;
 IF postmill_anchor_editorial_review_v1(s,'180','test-channel',snap)->'created' IS DISTINCT FROM 'true'::jsonb
 OR postmill_anchor_editorial_review_v1(s,'180','test-channel',snap)->'created' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'anchor replay invalid'; END IF;
 FOREACH bad IN ARRAY ARRAY[
  jsonb_set(cmd,'{expected_seq}','"1"'),jsonb_set(cmd,'{text,revision}','2'),
  jsonb_set(cmd,'{image}','{"revision":1,"sha256":"bad"}')
 ] LOOP
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',bad);
  RAISE EXCEPTION 'stale decision accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_STALE_DECISION' THEN RAISE; END IF; END;
 END LOOP;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',pg_temp.decision(snap,key1,'approve_final'));
  RAISE EXCEPTION 'premature final';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_INITIAL_ACTION_BLOCKED' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',pg_temp.decision(snap,key1,'request_image'));
  RAISE EXCEPTION 'duplicate initial image intent';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_INITIAL_ACTION_BLOCKED' THEN RAISE; END IF; END;
 FOREACH bad IN ARRAY ARRAY[
  pg_temp.decision(snap,key1,'request_text_changes',E' \t\n'),
  pg_temp.decision(snap,key1,'approve_text','unexpected feedback'),
  cmd||'{"actor_id":"victim"}'::jsonb,
  jsonb_set(cmd,'{feedback}',to_jsonb(repeat('x',4001))),
  jsonb_set(cmd,'{command_id}','"not-uuid"')
 ] LOOP
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',bad);
  RAISE EXCEPTION 'invalid decision accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(jsonb_set(s,'{org_id}','"org-b"'),'180','test-channel','actor-a',cmd);
  RAISE EXCEPTION 'wrong org accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DRAFT_NOT_FOUND' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','wrong-target','actor-a',cmd);
  RAISE EXCEPTION 'wrong target accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_UNAVAILABLE' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM "EditorialDecisionOutbox" WHERE "postId"=pid) THEN RAISE EXCEPTION 'failed request wrote event'; END IF;
 rec:=postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',cmd);
 again:=postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',cmd);
 ev:=rec->'event';
 IF rec->'newly_queued' IS DISTINCT FROM 'true'::jsonb OR again->'newly_queued' IS DISTINCT FROM 'false'::jsonb
 OR rec->'event' IS DISTINCT FROM again->'event' OR (SELECT count(*) FROM jsonb_object_keys(ev))<>13
 OR ev->'binding' IS DISTINCT FROM snap->'binding' OR ev->'text' IS DISTINCT FROM snap->'text'
 OR ev->>'feedback' IS DISTINCT FROM cmd->>'feedback' OR ev->>'actor_id' IS DISTINCT FROM 'actor-a'
 OR ev->>'producer' IS DISTINCT FROM 'postmill' OR ev->>'expected_seq' IS DISTINCT FROM '0'
 OR ev->'request_id' IS DISTINCT FROM 'null'::jsonb OR ev->'revision_content' IS DISTINCT FROM 'null'::jsonb
 OR ev->>'occurred_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
 OR rec->>'payload_sha256' IS DISTINCT FROM encode(sha256(convert_to(ev::text,'UTF8')),'hex')
 OR rec->>'remote_status' IS DISTINCT FROM 'unconfirmed'
 OR rec->'dispatch_authorized' IS DISTINCT FROM 'false'::jsonb
 OR rec->'publishable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'event contract mismatch'; END IF;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-b',cmd);
  RAISE EXCEPTION 'actor replay conflict accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_COMMAND_ID_CONFLICT' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',jsonb_set(cmd,'{feedback}','"other"'));
  RAISE EXCEPTION 'changed command accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_COMMAND_ID_CONFLICT' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'180','test-channel','actor-a',pg_temp.decision(snap,key2,'reject'));
  RAISE EXCEPTION 'second unconfirmed action accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_AWAITING_RECONCILIATION' THEN RAISE; END IF; END;
 BEGIN UPDATE "EditorialDecisionOutbox" SET payload='{}' WHERE "postId"=pid; RAISE EXCEPTION 'event mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN DELETE FROM "EditorialDecisionOutbox" WHERE "postId"=pid; RAISE EXCEPTION 'event deletable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN UPDATE "EditorialReviewAnchor" SET snapshot='{}' WHERE "postId"=pid; RAISE EXCEPTION 'anchor mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN UPDATE "Post" SET "approvalStatus"='approved' WHERE id=pid; RAISE EXCEPTION 'native approval allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_MANAGED_DRAFT_FROZEN' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=pid)<>1
 OR (SELECT snapshot FROM "EditorialReviewAnchor" WHERE "postId"=pid) IS DISTINCT FROM snap
 OR NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT' AND "approvalStatus"='pending') THEN
  RAISE EXCEPTION 'outbox caused mutation/approval'; END IF;
END $$;

-- Other permitted initial actions; use separate drafts, including manual
-- image intent, explicit no-image profile and automatic mode.
DO $$
DECLARE p jsonb; s jsonb; snap jsonb; res jsonb; mode text; task text; action text;
BEGIN
 FOR mode,task,action IN SELECT * FROM (VALUES ('manual','181','request_image'),('disabled','182','approve_text'),
  ('automatic','183','reject')) AS x(mode,task,action) LOOP
  p:=jsonb_set(pg_temp.prepared_draft(task),'{scope,image_mode}',to_jsonb(mode)); s:=p->'scope';
  snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
  PERFORM postmill_anchor_editorial_review_v1(s,task,'test-channel',snap);
  res:=postmill_queue_editorial_decision_v1(s,task,'test-channel','actor-a',
    pg_temp.decision(snap,'11111111-1111-4111-8111-111111111111',action));
  IF res->'newly_queued' IS DISTINCT FROM 'true'::jsonb OR res->'publishable' IS DISTINCT FROM 'false'::jsonb THEN
   RAISE EXCEPTION 'unexpected action result'; END IF;
 END LOOP;
END $$;

-- The event and anchor are both gone if the enclosing transaction rolls back.
BEGIN;
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('184'); s jsonb:=p->'scope'; snap jsonb;
BEGIN
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
 PERFORM postmill_anchor_editorial_review_v1(s,'184','test-channel',snap);
 PERFORM postmill_queue_editorial_decision_v1(s,'184','test-channel','actor-a',
  pg_temp.decision(snap,'11111111-1111-4111-8111-111111111111','approve_text'));
END $$;
ROLLBACK;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Post" WHERE "editorialTaskId"='184')
 OR (SELECT count(*) FROM "EditorialDecisionOutbox")<>4
 OR (SELECT count(*) FROM "EditorialReviewAnchor")<>4 THEN RAISE EXCEPTION 'partial transaction'; END IF;
END $$;
-- An anchor with no event for the independent-session CI test.
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('190'); snap jsonb;
BEGIN
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
 PERFORM postmill_anchor_editorial_review_v1(p->'scope','190','test-channel',snap);
END $$;
SELECT 'POSTMILL_EDITORIAL_DECISION_OUTBOX_OK';
