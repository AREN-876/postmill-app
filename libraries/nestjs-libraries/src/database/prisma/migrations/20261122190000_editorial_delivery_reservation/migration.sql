-- Durable send-once reservation. Recording the intent BEFORE HTTP means an
-- ambiguous network outcome is reconciled by signed lookup, never submitted again.
-- The original decision outbox and its immutable result remain unchanged.
BEGIN;

CREATE TABLE "EditorialDeliveryReservation" (
  "eventId" TEXT NOT NULL PRIMARY KEY,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialDeliveryReservation_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "EditorialDecisionOutbox"("eventId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE FUNCTION postmill_reserve_editorial_delivery_v1(
  s jsonb, task text, target text, eid text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE pending jsonb; inserted_count int;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000';
  END IF;
  IF eid IS NULL OR eid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR s->'is_test' IS DISTINCT FROM 'true'::jsonb
     OR target IS NULL OR target <> 'max:-73052031470103' THEN
    RAISE EXCEPTION 'EDITORIAL_RESERVATION_INVALID' USING ERRCODE='22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(s->>'org_id',task)::text,0));
  pending := public.postmill_read_editorial_delivery_v1(s,task,target);
  IF pending IS NULL THEN RETURN NULL; END IF;
  IF pending->>'event_id' IS DISTINCT FROM eid THEN
    RAISE EXCEPTION 'EDITORIAL_RESERVATION_EVENT_CHANGED' USING ERRCODE='55000';
  END IF;

  INSERT INTO public."EditorialDeliveryReservation"("eventId")
    VALUES (eid) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN jsonb_build_object('event_id',eid,'newly_reserved',inserted_count=1);
END $fn$;

REVOKE ALL ON FUNCTION postmill_reserve_editorial_delivery_v1(
  jsonb,text,text,text) FROM PUBLIC;
COMMIT;
