\set ON_ERROR_STOP on
DO $$
DECLARE s jsonb; row jsonb; pid text; eid text; h text;
BEGIN
 SELECT r.request->'scope' INTO STRICT s FROM "EditorialDraftReceipt" r
 JOIN "Post" p ON p.id=r."postId" WHERE p."editorialTaskId"='193';
 row:=postmill_read_editorial_delivery_v1(s,'193','test-channel');
 IF row IS NULL OR row->>'task_id'<>'193' OR row->>'org_id'<>'org-a'
  OR row->'event'->>'producer'<>'postmill' OR row->'event'->'binding'->>'task_id'<>'193'
  OR row->'event'->'binding'->'is_test' IS DISTINCT FROM 'true'::jsonb
  OR row->'dispatch_authorized' IS DISTINCT FROM 'false'::jsonb
  OR row->'publishable' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'pending read mismatch'; END IF;
 pid:=row->'event'->'binding'->>'post_id';eid:=row->>'event_id';h:=row->>'payload_sha256';
 IF h IS DISTINCT FROM (SELECT "payloadHash" FROM "EditorialDecisionOutbox" WHERE "eventId"=eid)
 OR h IS DISTINCT FROM encode(sha256(convert_to((row->'event')::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'event integrity mismatch'; END IF;
 IF postmill_read_editorial_delivery_v1(s,'193','test-channel') IS DISTINCT FROM row
  OR postmill_read_editorial_delivery_v1(jsonb_set(s,'{org_id}','"org-b"'),'193','test-channel') IS NOT NULL
  OR postmill_read_editorial_delivery_v1(s,'9999','test-channel') IS NOT NULL
  OR postmill_read_editorial_delivery_v1(s,'182','test-channel') IS NOT NULL THEN
  RAISE EXCEPTION 'read leaked stale or wrong org'; END IF;
 BEGIN PERFORM postmill_read_editorial_delivery_v1(s,'193','wrong-channel');
   RAISE EXCEPTION 'wrong physical target allowed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_UNAVAILABLE' THEN RAISE; END IF;
 END;
 -- Result of accepted seq+1 clears pending, without any send/worker side effects.
 PERFORM postmill_import_editorial_result_v1(s,'193','test-channel',eid,h,
 jsonb_build_object('status','accepted','reason',NULL,
 'state',(SELECT snapshot FROM "EditorialReviewAnchor" WHERE "postId"=pid)
     ||'{"seq":"1","text_status":"approved","final_approved":false}'::jsonb,
 'dispatch_authorized',false,'publishable',false,'newly_applied',false,'replay',true));
 IF postmill_read_editorial_delivery_v1(s,'193','test-channel') IS NOT NULL
  OR (SELECT count(*) FROM "EditorialDecisionOutbox" WHERE "postId"=pid)<>1
  OR NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT' AND "approvalStatus"='pending')
 THEN RAISE EXCEPTION 'read caused write or failed to suppress confirmed event'; END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_TRANSPORT_PENDING_OK';
