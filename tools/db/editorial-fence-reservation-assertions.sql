\set ON_ERROR_STOP on
-- Exercise the real additive send-once migration against the PostgreSQL 17
-- fixture. The SQL function enforces the exact test target; restore the
-- fixture's default target before legacy concurrency assertions.
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('196'); s jsonb:=p->'scope';
 snap jsonb; ev jsonb; eid text; first_result jsonb; replay jsonb;
 wrong_org jsonb; pid text;
 target text:='max:-73052031470103';
BEGIN
 UPDATE "Integration" SET "internalId"=target WHERE id='max-a';
 snap:=pg_temp.initial_review(postmill_exchange_create_v1(p,target));
 pid:=snap->'binding'->>'post_id';
 PERFORM postmill_anchor_editorial_review_v1(s,'196',target,snap);
 ev:=postmill_queue_editorial_decision_v1(s,'196',target,'actor-a',
  pg_temp.decision(snap,'11111111-1111-4111-8111-111111111111','approve_text'));
 eid:=ev->'event'->>'event_id';

 first_result:=postmill_reserve_editorial_delivery_v1(s,'196',target,eid);
 replay:=postmill_reserve_editorial_delivery_v1(s,'196',target,eid);
 IF first_result->>'event_id' IS DISTINCT FROM eid
   OR first_result->'newly_reserved' IS DISTINCT FROM 'true'::jsonb
   OR replay->>'event_id' IS DISTINCT FROM eid
   OR replay->'newly_reserved' IS DISTINCT FROM 'false'::jsonb
   OR (SELECT count(*) FROM "EditorialDeliveryReservation" WHERE "eventId"=eid) <> 1
 THEN RAISE EXCEPTION 'reservation not send-once'; END IF;

 wrong_org:=postmill_reserve_editorial_delivery_v1(
   jsonb_set(s,'{org_id}','"org-b"'),'196',target,eid);
 IF wrong_org IS NOT NULL THEN RAISE EXCEPTION 'cross-org reservation accepted'; END IF;
 BEGIN
  PERFORM postmill_reserve_editorial_delivery_v1(s,'196',target,
    '22222222-2222-4222-8222-222222222222');
  RAISE EXCEPTION 'changed event id accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM <> 'EDITORIAL_RESERVATION_EVENT_CHANGED' THEN RAISE; END IF;
 END;
 BEGIN
  DELETE FROM "EditorialDeliveryReservation" WHERE "eventId"=eid;
  RAISE EXCEPTION 'reservation deletable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM <> 'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF;
 END;
 BEGIN
  UPDATE "EditorialDeliveryReservation" SET "reservedAt"=now() WHERE "eventId"=eid;
  RAISE EXCEPTION 'reservation mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM <> 'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF;
 END;
 -- Preserve all original fixture targets for the cross-session checks below.
 UPDATE "Integration" SET "internalId"='test-channel' WHERE id='max-a';
 IF NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT') THEN
  RAISE EXCEPTION 'reservation changed native draft'; END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_SUBMIT_ONCE_RESERVATION_OK';
