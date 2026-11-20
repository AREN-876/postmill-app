-- 06B-3C: inactive scoped read of exactly one pending outbox event.
-- NO automatic send/claim/reservation. A remote uncertain result remains pending
-- until explicit read-only reconciliation, never a new event or paid retry.
BEGIN;
CREATE FUNCTION postmill_read_editorial_delivery_v1(s jsonb, task text, target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE review jsonb; row_event "EditorialDecisionOutbox"%ROWTYPE;
 pid text;
BEGIN
 review:=postmill_read_editorial_review_v1(s,task,target);
 IF review IS NULL THEN RETURN NULL; END IF;
 IF review->'review'->>'status' IS DISTINCT FROM 'pending' THEN RETURN NULL; END IF;
 pid:=review->'receipt'->'binding'->>'post_id';
 SELECT o.* INTO row_event FROM "EditorialDecisionOutbox" o
 LEFT JOIN "EditorialDecisionResult" d ON d."eventId"=o."eventId"
 WHERE o."postId"=pid AND d."eventId" IS NULL
 ORDER BY o."expectedSeq"::bigint DESC LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_DELIVERY_INCONSISTENT' USING ERRCODE='55000'; END IF;
 IF row_event."eventId" IS DISTINCT FROM review->'review'->>'latest_event_id'
  OR row_event.payload->'binding' IS DISTINCT FROM review->'review'->'last_confirmed_state'->'binding'
  OR row_event.payload->>'expected_seq' IS DISTINCT FROM review->'review'->'last_confirmed_state'->>'seq'
  OR row_event.payload->'text' IS DISTINCT FROM review->'review'->'last_confirmed_state'->'text'
  OR row_event.payload->'image' IS DISTINCT FROM review->'review'->'last_confirmed_state'->'image'
  OR row_event.payload->>'producer' IS DISTINCT FROM 'postmill'
  OR row_event.payload->>'event_id' IS DISTINCT FROM row_event."eventId"
  OR row_event.payload->'binding'->>'task_id' IS DISTINCT FROM task
  OR row_event.payload->'binding'->>'org_id' IS DISTINCT FROM s->>'org_id'
  OR row_event.payload->'binding'->'is_test' IS DISTINCT FROM 'true'::jsonb
  OR row_event."payloadHash" IS DISTINCT FROM
     encode(sha256(convert_to(row_event.payload::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'EDITORIAL_DELIVERY_INCONSISTENT' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('schema_version',1,'org_id',s->>'org_id','task_id',task,
   'event_id',row_event."eventId",'payload_sha256',row_event."payloadHash",
   'event',row_event.payload,
   'dispatch_authorized',false,'publishable',false);
END $fn$;
REVOKE ALL ON FUNCTION postmill_read_editorial_delivery_v1(jsonb,text,text) FROM PUBLIC;
COMMIT;
