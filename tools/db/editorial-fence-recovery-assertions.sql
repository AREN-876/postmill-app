\set ON_ERROR_STOP on
-- Disposable fixture only: age synthetic reservations by inserting historical
-- timestamps; production never edits/deletes either immutable reservation.
BEGIN;
DO $recovery$
DECLARE task text; p jsonb; s jsonb; snap jsonb; ev jsonb; eid text; digest text;
 target text:='max:-73052031470103'; pid text;
BEGIN
 UPDATE "Integration" SET "internalId"=target WHERE id='max-a';
 FOREACH task IN ARRAY ARRAY['2961','2962','2963','2964'] LOOP
  p:=pg_temp.prepared_draft(task); s:=p->'scope';
  snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,target));
  pid:=snap->'binding'->>'post_id';
  PERFORM postmill_anchor_editorial_review_v1(s,task,target,snap);
  ev:=postmill_queue_editorial_decision_v1(s,task,target,'actor-a',
    pg_temp.decision(snap,'11111111-1111-4111-8111-111111111111','approve_text'));
  eid:=ev->'event'->>'event_id'; digest:=ev->>'payload_sha256';
  IF postmill_reserve_editorial_recovery_v1(s,task,target,eid,digest) IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'recovery without primary reservation'; END IF;
  IF task='2964' THEN
    PERFORM postmill_reserve_editorial_delivery_v1(s,task,target,eid);
    IF postmill_reserve_editorial_recovery_v1(s,task,target,eid,digest) IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'primary cooldown bypassed'; END IF;
    CONTINUE;
  END IF;
  INSERT INTO "EditorialDeliveryReservation"("eventId","reservedAt")
    VALUES (eid,clock_timestamp()::timestamp-interval '40 minutes');
  IF task='2962' OR task='2963' THEN
   INSERT INTO "EditorialDeliveryRecovery"("eventId",attempt,"reservedAt")
     VALUES (eid,1,clock_timestamp()::timestamp-interval '25 minutes');
  END IF;
  IF task='2963' THEN
   INSERT INTO "EditorialDeliveryRecovery"("eventId",attempt,"reservedAt")
     VALUES (eid,2,clock_timestamp()::timestamp-interval '15 minutes');
   IF postmill_reserve_editorial_recovery_v1(s,task,target,eid,digest) IS DISTINCT FROM false
   THEN RAISE EXCEPTION 'recovery limit bypassed'; END IF;
   CONTINUE;
  END IF;
  BEGIN
   PERFORM postmill_reserve_editorial_recovery_v1(s,task,target,eid,repeat('0',64));
   RAISE EXCEPTION 'wrong hash accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM <> 'EDITORIAL_RECOVERY_EVENT_CHANGED' THEN RAISE; END IF;
  END;
  IF postmill_reserve_editorial_recovery_v1(jsonb_set(s,'{org_id}','"org-b"'),task,target,eid,digest)
    IS DISTINCT FROM false THEN RAISE EXCEPTION 'cross-org recovery'; END IF;
  IF postmill_reserve_editorial_recovery_v1(s,task,target,eid,digest) IS DISTINCT FROM true
  THEN RAISE EXCEPTION 'aged recovery refused'; END IF;
  IF postmill_reserve_editorial_recovery_v1(s,task,target,eid,digest) IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'recovery cooldown/limit bypassed'; END IF;
  IF (SELECT count(*) FROM "EditorialDeliveryReservation" WHERE "eventId"=eid)<>1
    OR (SELECT count(*) FROM "EditorialDeliveryRecovery" WHERE "eventId"=eid)
       <>(CASE WHEN task='2961' THEN 1 ELSE 2 END)
    OR (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=pid)<>1
    OR NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT')
  THEN RAISE EXCEPTION 'recovery ledger/native draft mismatch'; END IF;
  BEGIN
   UPDATE "EditorialDeliveryRecovery" SET "reservedAt"=now() WHERE "eventId"=eid;
   RAISE EXCEPTION 'mutable recovery';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM <> 'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF;
  END;
  BEGIN
   DELETE FROM "EditorialDeliveryRecovery" WHERE "eventId"=eid;
   RAISE EXCEPTION 'deletable recovery';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM <> 'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF;
  END;
 END LOOP;
 UPDATE "Integration" SET "internalId"='test-channel' WHERE id='max-a';
END $recovery$;
ROLLBACK;
SELECT 'POSTMILL_EDITORIAL_BOUNDED_RECOVERY_OK';
