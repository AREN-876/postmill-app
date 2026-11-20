\set ON_ERROR_STOP on
-- 06B-4A: synthetic native draft + session-scope SQL boundary. This test
-- exercises PostgreSQL 17, not actual SessionAuth or a production workspace.
DO $$
DECLARE
 p jsonb:=pg_temp.prepared_draft('198'); s jsonb:=p->'scope';
 created jsonb; readback jsonb; response jsonb; replay jsonb;
 post_id text; event_id text; cmd jsonb;
BEGIN
 created:=postmill_exchange_create_v1(p,'test-channel');
 post_id:=created->'receipt'->'binding'->>'post_id';
 PERFORM postmill_anchor_editorial_review_v1(s,'198','test-channel',pg_temp.initial_review(created));
 readback:=postmill_read_editorial_human_v1('org-a',post_id,'198','test-channel');
 IF readback IS NULL OR readback->>'post_id'<>post_id
   OR readback->>'task_id'<>'198'
   OR readback->'content' IS DISTINCT FROM p->'content'
   OR readback->'review_acknowledged' IS DISTINCT FROM 'true'::jsonb
   OR readback->'review'->'last_confirmed_state'->>'seq'<>'0'
   OR readback->'dispatch_authorized' IS DISTINCT FROM 'false'::jsonb
   OR readback->'publishable' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'human review read mismatch';
 END IF;
 IF postmill_read_editorial_human_v1('org-b',post_id,'198','test-channel') IS NOT NULL
  OR postmill_read_editorial_human_v1('org-a',repeat('0',32),'198','test-channel') IS NOT NULL
  OR postmill_read_editorial_human_v1('org-a',post_id,'199','test-channel') IS NOT NULL
  OR postmill_read_editorial_human_v1('org-a',post_id,'198','other-channel') IS NOT NULL THEN
  RAISE EXCEPTION 'human review leaked cross org, post or target';
 END IF;
 cmd:=jsonb_build_object('command_id','11111111-1111-4111-8111-111111111111',
   'expected_seq','0','action','approve_text','feedback','');
 response:=postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel','editor-a',cmd);
 replay:=postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel','editor-a',cmd);
 event_id:=response->>'event_id';
 IF event_id IS NULL OR response->>'status'<>'queued/unconfirmed'
  OR response->'newly_queued' IS DISTINCT FROM 'true'::jsonb
  OR replay->'replay' IS DISTINCT FROM 'true'::jsonb
  OR replay->>'event_id'<>event_id
  OR (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=post_id)<>1
  OR (SELECT payload->'text' FROM "EditorialDecisionOutbox" WHERE "eventId"=event_id)
      IS DISTINCT FROM readback->'review'->'last_confirmed_state'->'text'
  OR (SELECT payload->>'actor_id' FROM "EditorialDecisionOutbox" WHERE "eventId"=event_id)<>'editor-a'
  OR response->'publishable' IS DISTINCT FROM 'false'::jsonb
  OR NOT EXISTS(SELECT 1 FROM "Post" WHERE id=post_id AND state='DRAFT'
                  AND "approvalStatus"='pending') THEN
  RAISE EXCEPTION 'human review queue/replay mismatch';
 END IF;
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel',
    'editor-b',cmd);
  RAISE EXCEPTION 'cross actor command replay allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
 END;
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel',
   'editor-a',jsonb_set(cmd,'{action}','"reject"'));
  RAISE EXCEPTION 'command payload mutation allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
 END;
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel',
   'editor-a',jsonb_set(cmd,'{command_id}','"22222222-2222-4222-8222-222222222222"'));
  RAISE EXCEPTION 'second command while pending allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
 END;
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel',
    'editor-a',cmd||'{"actor_id":"spoofed"}'::jsonb);
  RAISE EXCEPTION 'claimed actor allowed';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',post_id,'198','test-channel',
    'editor-a',jsonb_set(cmd,'{feedback}','"wrong feedback"'));
  RAISE EXCEPTION 'invalid feedback allowed';
 EXCEPTION WHEN invalid_parameter_value THEN NULL;
 END;
 IF postmill_queue_editorial_human_v1('org-b',post_id,'198','test-channel',
   'editor-a',cmd) IS NOT NULL THEN RAISE EXCEPTION 'cross org queued'; END IF;
 IF (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=post_id)<>1 THEN
  RAISE EXCEPTION 'queue wrote extra events';
 END IF;
END $$;
-- Terminal decisions, stale sequence and subtransaction rollback.
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('199'); s jsonb:=p->'scope';
 initial jsonb; st jsonb; pid text; result jsonb; event_id text; event jsonb;
 cmd jsonb:=jsonb_build_object('command_id','33333333-3333-4333-8333-333333333333',
  'expected_seq','0','action','reject','feedback','');
BEGIN
 initial:=postmill_exchange_create_v1(p,'test-channel');
 pid:=initial->'receipt'->'binding'->>'post_id';
 st:=pg_temp.initial_review(initial);
 PERFORM postmill_anchor_editorial_review_v1(s,'199','test-channel',st);
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',pid,'199','test-channel',
   'editor-a',jsonb_set(cmd,'{expected_seq}','"1"'));
  RAISE EXCEPTION 'stale human sequence allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
 END;
 result:=postmill_queue_editorial_human_v1('org-a',pid,'199','test-channel','editor-a',cmd);
 event_id:=result->>'event_id';
 SELECT payload INTO event FROM "EditorialDecisionOutbox" WHERE "eventId"=event_id;
 st:=postmill_editorial_next_state_v1(st,event);
 IF st IS NULL OR st->'rejected' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'expected terminal reject transition not computed';
 END IF;
 PERFORM postmill_import_editorial_result_v1(s,'199','test-channel',event_id,
   (SELECT "payloadHash" FROM "EditorialDecisionOutbox" WHERE "eventId"=event_id),
   jsonb_build_object('status','accepted','reason',NULL,'state',st,
    'dispatch_authorized',false,'publishable',false,'newly_applied',false,'replay',true));
 IF (postmill_queue_editorial_human_v1('org-a',pid,'199','test-channel',
   'editor-a',cmd))->>'event_id'<>event_id THEN
  RAISE EXCEPTION 'terminal decision idempotent replay changed event';
 END IF;
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',pid,'199','test-channel','editor-a',
   jsonb_build_object('command_id','44444444-4444-4444-8444-444444444444',
     'expected_seq','1','action','approve_text','feedback',''));
  RAISE EXCEPTION 'terminal rejection recovery incorrectly allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
 END;
 IF (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=pid)<>1 THEN
  RAISE EXCEPTION 'terminal rejection emitted a second decision';
 END IF;
END $$;
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('200'); s jsonb:=p->'scope';
 initial jsonb; pid text;
 cmd jsonb:=jsonb_build_object('command_id','55555555-5555-4555-8555-555555555555',
  'expected_seq','0','action','approve_text','feedback','');
BEGIN
 initial:=postmill_exchange_create_v1(p,'test-channel');
 pid:=initial->'receipt'->'binding'->>'post_id';
 PERFORM postmill_anchor_editorial_review_v1(s,'200','test-channel',pg_temp.initial_review(initial));
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-a',pid,'200','test-channel','editor-a',cmd);
  RAISE EXCEPTION 'forced rollback of same transaction';
 EXCEPTION WHEN raise_exception THEN NULL;
 END;
 IF EXISTS(SELECT 1 FROM "EditorialDecisionOutbox" WHERE "postId"=pid) THEN
  RAISE EXCEPTION 'human queue survived transaction rollback';
 END IF;
 IF (postmill_queue_editorial_human_v1('org-a',pid,'200','test-channel',
   'editor-a',cmd))->'newly_queued' IS DISTINCT FROM 'true'::jsonb THEN
  RAISE EXCEPTION 'fresh queue after rollback failed';
 END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_HUMAN_REVIEW_OK';
