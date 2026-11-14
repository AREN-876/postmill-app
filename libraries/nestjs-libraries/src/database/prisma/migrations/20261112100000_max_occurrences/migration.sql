ALTER TABLE "Post" ADD COLUMN "maxScheduleRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "MaxDeliveryOccurrence" (
 "id" TEXT PRIMARY KEY, "postId" TEXT NOT NULL REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "organizationId" TEXT NOT NULL, "parentId" TEXT UNIQUE, "scheduledAt" TIMESTAMP(3) NOT NULL,
 "fingerprint" TEXT NOT NULL, "continued" BOOLEAN NOT NULL DEFAULT false, "state" TEXT NOT NULL DEFAULT 'READY', "attempt" INTEGER NOT NULL DEFAULT 0,
 "receipt" JSONB, "legacy" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "MaxDeliveryOccurrence_state_scheduledAt_idx" ON "MaxDeliveryOccurrence"("state", "scheduledAt");
CREATE INDEX "MaxDeliveryOccurrence_postId_organizationId_idx" ON "MaxDeliveryOccurrence"("postId", "organizationId");
CREATE TABLE "MaxDeliveryAttempt" (
 "id" TEXT PRIMARY KEY, "occurrenceId" TEXT NOT NULL REFERENCES "MaxDeliveryOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "number" INTEGER NOT NULL, "state" TEXT NOT NULL, "target" JSONB NOT NULL, "receipt" JSONB,
 "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE ("occurrenceId", "number")
);
INSERT INTO "MaxDeliveryOccurrence" ("id", "postId", "organizationId", "scheduledAt", "fingerprint", "state", "attempt", "receipt", "legacy", "updatedAt", "continued")
SELECT 'max_legacy_' || p.id, p.id, p."organizationId", p."publishDate", '',
 CASE WHEN p."maxDelivery" IS NULL THEN 'READY' ELSE CASE p."maxDelivery"->>'state' WHEN 'CONFIRMED' THEN 'CONFIRMED' WHEN 'READY' THEN 'READY' ELSE 'REVIEW' END END,
 COALESCE((p."maxDelivery"->>'attempt')::integer,0), p."maxDelivery"->'receipt', COALESCE(p."maxDelivery",'{}'::jsonb) || jsonb_build_object('template', jsonb_build_object(
 'maxScheduleRevision',p."maxScheduleRevision", 'publishDate',to_char(p."publishDate",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'intervalInDays',p."intervalInDays", 'content',p.content,'image',p.image,'settings',p.settings,
 'integrationId',p."integrationId",'campaignId',p."campaignId",
 'integration',jsonb_build_object('internalId',i."internalId",'providerVersion',i."providerVersion"))), CURRENT_TIMESTAMP, true
FROM "Post" p JOIN "Integration" i ON i.id=p."integrationId"
WHERE i."providerIdentifier"='max' AND (p."maxDelivery" IS NOT NULL OR p.state IN ('QUEUE','PUBLISHING'));
INSERT INTO "MaxDeliveryAttempt" ("id", "occurrenceId", "number", "state", "target", "receipt")
SELECT id || '_legacy', id, attempt, state, COALESCE(legacy->'target','{}'::jsonb), receipt FROM "MaxDeliveryOccurrence" WHERE attempt > 0 OR state <> 'READY';
UPDATE "Post" p SET "maxDelivery" = jsonb_build_object('occurrenceId', o.id,
 'state', CASE WHEN o.state='REVIEW' THEN 'STARTED' ELSE o.state END, 'attempt', o.attempt, 'receipt', o.receipt)
FROM "MaxDeliveryOccurrence" o WHERE o."postId"=p.id;
