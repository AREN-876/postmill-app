-- Recovery is deliberately separate from the immutable original send reservation.
-- Two additional attempts, at least ten minutes apart, only for the existing
-- exact test event. The caller must have authenticated a signed missing lookup.
-- No publication or AI request is covered by this contract.
BEGIN;

CREATE TABLE "EditorialDeliveryRecovery" (
  "eventId" TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialDeliveryRecovery_pkey" PRIMARY KEY ("eventId",attempt),
  CONSTRAINT "EditorialDeliveryRecovery_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "EditorialDeliveryReservation"("eventId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialDeliveryRecovery_attempt_check" CHECK (attempt IN (1,2))
);

CREATE TRIGGER "EditorialDeliveryRecovery_immutable_v1"
  BEFORE UPDATE OR DELETE ON "EditorialDeliveryRecovery"
  FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();

CREATE FUNCTION postmill_reserve_editorial_recovery_v1(
  s jsonb, task text, target text, eid text, digest text
) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE pending jsonb; first_at timestamp; last_at timestamp; attempts int;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000';
  END IF;
  IF eid IS NULL OR eid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR digest IS NULL OR digest !~ '^[0-9a-f]{64}$'
     OR s->'is_test' IS DISTINCT FROM 'true'::jsonb
     OR target IS DISTINCT FROM 'max:-73052031470103' THEN
    RAISE EXCEPTION 'EDITORIAL_RECOVERY_INVALID' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(s->>'org_id',task)::text,0));
  pending := public.postmill_read_editorial_delivery_v1(s,task,target);
  IF pending IS NULL THEN RETURN false; END IF;
  IF pending->>'event_id' IS DISTINCT FROM eid
     OR pending->>'payload_sha256' IS DISTINCT FROM digest THEN
    RAISE EXCEPTION 'EDITORIAL_RECOVERY_EVENT_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT "reservedAt" INTO first_at FROM "EditorialDeliveryReservation" WHERE "eventId"=eid;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*)::int,max("reservedAt") INTO attempts,last_at
    FROM "EditorialDeliveryRecovery" WHERE "eventId"=eid;
  IF attempts>=2 OR greatest(first_at,coalesce(last_at,first_at)) >
       clock_timestamp()::timestamp - interval '10 minutes' THEN
    RETURN false;
  END IF;
  INSERT INTO "EditorialDeliveryRecovery"("eventId",attempt,"reservedAt")
    VALUES (eid,attempts+1,clock_timestamp()::timestamp);
  RETURN true;
END $fn$;

REVOKE ALL ON "EditorialDeliveryRecovery" FROM PUBLIC;
REVOKE ALL ON FUNCTION postmill_reserve_editorial_recovery_v1(jsonb,text,text,text,text) FROM PUBLIC;
COMMIT;
