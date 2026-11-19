\set ON_ERROR_STOP on
-- Expected snapshots below are explicit Editorial-013 transitions,
-- independent of postmill_editorial_next_state_v1 implementation.
CREATE FUNCTION pg_temp.result_reply(state jsonb, status text DEFAULT 'accepted', reason text DEFAULT NULL,
 replay boolean DEFAULT false) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('status',status,'reason',reason,'state',state,
 'dispatch_authorized',false,'publishable',false,
 'newly_applied',status='accepted' AND NOT replay,'replay',replay)
$$;
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('191'); s jsonb:=p->'scope';
 snap jsonb; state1 jsonb; state2 jsonb; cmd jsonb; ev1 jsonb; ev2 jsonb; result jsonb;
 eid text; h text; prior jsonb; reply jsonb; res jsonb; pid text; bad jsonb;
 key1 text:='11111111-1111-4111-8111-111111111111';
 key2 text:='22222222-2222-4222-8222-222222222222';
 key3 text:='33333333-3333-4333-8333-333333333333';
BEGIN
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
 pid:=snap->'binding'->>'post_id';
 IF postmill_read_editorial_review_v1(s,'191','test-channel')->'review_acknowledged' IS DISTINCT FROM 'false'::jsonb
 OR postmill_read_editorial_review_v1(s,'9999','test-channel') IS NOT NULL THEN RAISE EXCEPTION 'bad initial read'; END IF;
 PERFORM postmill_anchor_editorial_review_v1(s,'191','test-channel',snap);
 prior:=postmill_read_editorial_review_v1(s,'191','test-channel');
 IF prior->'review'->>'status' IS DISTINCT FROM 'idle'
 OR prior->'review'->'last_confirmed_state' IS DISTINCT FROM snap
 OR prior->'review_acknowledged' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'anchor read mismatch'; END IF;
 cmd:=pg_temp.decision(snap,key1,'approve_text');
 ev1:=postmill_queue_editorial_decision_v1(s,'191','test-channel','actor-a',cmd);
 eid:=ev1->'event'->>'event_id'; h:=ev1->>'payload_sha256';
 state1:=snap||'{"seq":"1","text_status":"approved","final_approved":false}'::jsonb;
 reply:=pg_temp.result_reply(state1);
 IF postmill_read_editorial_review_v1(s,'191','test-channel')->'review'->>'status' IS DISTINCT FROM 'pending' THEN
  RAISE EXCEPTION 'missing pending state'; END IF;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'191','test-channel','actor-a',pg_temp.decision(snap,key2,'reject'));
  RAISE EXCEPTION 'queued before acknowledgement';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_AWAITING_RECONCILIATION' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_import_editorial_result_v1(s,'191','test-channel',eid,repeat('0',64),reply);
  RAISE EXCEPTION 'wrong event hash accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_EVENT_HASH_MISMATCH' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_import_editorial_result_v1(s,'191','test-channel','wrong-id',h,reply);
  RAISE EXCEPTION 'wrong event accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_EVENT_NOT_FOUND' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_import_editorial_result_v1(jsonb_set(s,'{org_id}','"org-b"'),'191','test-channel',eid,h,reply);
  RAISE EXCEPTION 'wrong org accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DRAFT_NOT_FOUND' THEN RAISE; END IF; END;
 FOREACH bad IN ARRAY ARRAY[
  reply||'{"extra":true}',jsonb_set(reply,'{newly_applied}','false'),
  jsonb_set(reply,'{replay}','"malformed"'),jsonb_set(reply,'{publishable}','true'),
  jsonb_set(reply,'{dispatch_authorized}','true'),jsonb_set(reply,'{reason}','"unexpected"')
 ] LOOP
 BEGIN PERFORM postmill_import_editorial_result_v1(s,'191','test-channel',eid,h,bad);
  RAISE EXCEPTION 'invalid result accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 FOREACH bad IN ARRAY ARRAY[
  jsonb_set(reply,'{state,seq}','"2"'),jsonb_set(reply,'{state,text,revision}','2'),
  jsonb_set(reply,'{state,binding,post_id}','"wrong"'),
  jsonb_set(reply,'{state,final_approved}','true'),
  jsonb_set(reply,'{state,image_intent}','null'),
  pg_temp.result_reply(state1,'rejected','stale_sequence')
 ] LOOP
 BEGIN PERFORM postmill_import_editorial_result_v1(s,'191','test-channel',eid,h,bad);
  RAISE EXCEPTION 'divergent snapshot accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_RESULT_STATE_MISMATCH' THEN RAISE; END IF; END;
 END LOOP;
 IF EXISTS(SELECT 1 FROM "EditorialDecisionResult" WHERE "eventId"=eid) THEN RAISE EXCEPTION 'invalid receipt persisted'; END IF;
 -- A lost first response may be recovered from an exact remote replay.
 res:=postmill_import_editorial_result_v1(s,'191','test-channel',eid,h,pg_temp.result_reply(state1,replay=>true));
 IF res->'newly_recorded' IS DISTINCT FROM 'true'::jsonb
 OR res->'outcome' IS DISTINCT FROM reply-ARRAY['replay','newly_applied']
 OR res->>'outcome_sha256' IS DISTINCT FROM encode(sha256(convert_to((res->'outcome')::text,'UTF8')),'hex')
 OR res->'publishable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'bad receipt'; END IF;
 IF postmill_import_editorial_result_v1(s,'191','test-channel',eid,h,reply)->'newly_recorded' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'duplicate result recorded'; END IF;
 BEGIN PERFORM postmill_import_editorial_result_v1(s,'191','test-channel',eid,h,pg_temp.result_reply(snap,'rejected','task_not_eligible'));
  RAISE EXCEPTION 'changed result accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_RESULT_CONFLICT' THEN RAISE; END IF; END;
 IF postmill_queue_editorial_decision_v1(s,'191','test-channel','actor-a',cmd)->>'remote_status' IS DISTINCT FROM 'accepted' THEN
  RAISE EXCEPTION 'historical retry status incorrect'; END IF;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'191','test-channel','actor-a',pg_temp.decision(snap,key2,'reject'));
  RAISE EXCEPTION 'stale sequence accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_STALE_DECISION' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'191','test-channel','actor-a',pg_temp.decision(state1,key2,'approve_text'));
  RAISE EXCEPTION 'repeated text approval accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_ACTION_BLOCKED' THEN RAISE; END IF; END;
 ev2:=postmill_queue_editorial_decision_v1(s,'191','test-channel','actor-a',pg_temp.decision(state1,key2,'request_text_changes','Уточнить'));
 state2:=state1||jsonb_build_object('seq','2','text_status','changes_requested',
  'text_request_id',ev2->'event'->>'event_id','image_intent',NULL,'final_approved',false);
 res:=postmill_import_editorial_result_v1(s,'191','test-channel',ev2->'event'->>'event_id',
  ev2->>'payload_sha256',pg_temp.result_reply(state2));
 IF res->'newly_recorded' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'second receipt failed'; END IF;
 -- Historical replay must not regress the current confirmed state.
 PERFORM postmill_import_editorial_result_v1(s,'191','test-channel',eid,h,reply);
 result:=postmill_read_editorial_review_v1(s,'191','test-channel');
 IF result->'review'->'last_confirmed_state' IS DISTINCT FROM state2
 OR result->'review'->>'status' IS DISTINCT FROM 'idle'
 OR result->'review'->'remote_current_verified' IS DISTINCT FROM 'false'::jsonb
 OR result->'dispatch_authorized' IS DISTINCT FROM 'false'::jsonb
 OR result->'publishable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'confirmed state mismatch'; END IF;
 BEGIN UPDATE "EditorialDecisionResult" SET outcome='{}' WHERE "eventId"=eid; RAISE EXCEPTION 'mutable receipt';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN DELETE FROM "EditorialDecisionResult" WHERE "eventId"=eid; RAISE EXCEPTION 'deletable receipt';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF; END;
 IF NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT' AND "approvalStatus"='pending')
 OR (SELECT snapshot FROM "EditorialReviewAnchor" WHERE "postId"=pid) IS DISTINCT FROM snap THEN
  RAISE EXCEPTION 'native state or initial anchor changed'; END IF;
END $$;

-- A definitive rejection with unchanged state is recorded, but cannot open
-- another event at the same sequence without an explicit recovery protocol.
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('192'); s jsonb:=p->'scope'; snap jsonb; ev jsonb; rec jsonb; eid text;
BEGIN
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
 PERFORM postmill_anchor_editorial_review_v1(s,'192','test-channel',snap);
 ev:=postmill_queue_editorial_decision_v1(s,'192','test-channel','actor-a',
  pg_temp.decision(snap,'11111111-1111-4111-8111-111111111111','approve_text'));
 eid:=ev->'event'->>'event_id';
 rec:=postmill_import_editorial_result_v1(s,'192','test-channel',eid,ev->>'payload_sha256',
  pg_temp.result_reply(snap,'rejected','task_not_eligible'));
 IF rec->'outcome'->>'status' IS DISTINCT FROM 'rejected'
 OR postmill_read_editorial_review_v1(s,'192','test-channel')->'review'->>'status' IS DISTINCT FROM 'rejected' THEN
  RAISE EXCEPTION 'rejected result missing'; END IF;
 BEGIN PERFORM postmill_queue_editorial_decision_v1(s,'192','test-channel','actor-a',
  pg_temp.decision(snap,'22222222-2222-4222-8222-222222222222','reject'));
  RAISE EXCEPTION 'rejected sequence reopened';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DECISION_RECONCILIATION_REQUIRED' THEN RAISE; END IF; END;
END $$;

-- Check terminal rejection, disabled final flag, and manual image intent.
DO $$
DECLARE task text; snap jsonb; s jsonb; evt "EditorialDecisionOutbox"%ROWTYPE; next_state jsonb;
BEGIN
 FOREACH task IN ARRAY ARRAY['181','182','183'] LOOP
  SELECT r.request->'scope',a.snapshot INTO s,snap FROM "EditorialReviewAnchor" a
  JOIN "EditorialDraftReceipt" r ON r."postId"=a."postId" JOIN "Post" p ON p.id=a."postId" WHERE p."editorialTaskId"=task;
  SELECT * INTO STRICT evt FROM "EditorialDecisionOutbox" WHERE "postId"=snap->'binding'->>'post_id';
  next_state:=snap||'{"seq":"1"}'::jsonb;
  CASE task WHEN '181' THEN next_state:=next_state||jsonb_build_object('image_intent','event:'||evt."eventId");
   WHEN '182' THEN next_state:=next_state||'{"text_status":"approved","final_approved":true}'::jsonb;
   WHEN '183' THEN next_state:=next_state||'{"rejected":true,"image_intent":null}'::jsonb;
  END CASE;
  PERFORM postmill_import_editorial_result_v1(s,task,'test-channel',evt."eventId",evt."payloadHash",pg_temp.result_reply(next_state));
  IF postmill_read_editorial_review_v1(s,task,'test-channel')->'review'->'last_confirmed_state' IS DISTINCT FROM next_state THEN
   RAISE EXCEPTION 'mode transition mismatch'; END IF;
  IF task='183' THEN
   BEGIN PERFORM postmill_queue_editorial_decision_v1(s,task,'test-channel','actor-a',
    pg_temp.decision(next_state,'22222222-2222-4222-8222-222222222222','approve_text'));
    RAISE EXCEPTION 'terminal review reopened';
   EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_ACTION_BLOCKED' THEN RAISE; END IF; END;
  END IF;
 END LOOP;
END $$;

-- A rolled-back result remains pending. Prepare independent-session fixture.
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('193'); snap jsonb;
BEGIN
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,'test-channel'));
 PERFORM postmill_anchor_editorial_review_v1(p->'scope','193','test-channel',snap);
 PERFORM postmill_queue_editorial_decision_v1(p->'scope','193','test-channel','actor-a',
  pg_temp.decision(snap,'11111111-1111-4111-8111-111111111111','approve_text'));
END $$;
BEGIN;
SELECT postmill_import_editorial_result_v1(r.request->'scope','193','test-channel',o."eventId",o."payloadHash",
 pg_temp.result_reply(a.snapshot||'{"seq":"1","text_status":"approved","final_approved":false}'::jsonb))
 FROM "EditorialDecisionOutbox" o JOIN "EditorialReviewAnchor" a ON a."postId"=o."postId"
 JOIN "EditorialDraftReceipt" r ON r."postId"=a."postId" JOIN "Post" p ON p.id=o."postId" WHERE p."editorialTaskId"='193';
ROLLBACK;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "EditorialDecisionResult" x JOIN "EditorialDecisionOutbox" o ON o."eventId"=x."eventId"
 JOIN "Post" p ON p.id=o."postId" WHERE p."editorialTaskId"='193') THEN RAISE EXCEPTION 'result rollback failed'; END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_RESULT_RECEIPT_OK';
