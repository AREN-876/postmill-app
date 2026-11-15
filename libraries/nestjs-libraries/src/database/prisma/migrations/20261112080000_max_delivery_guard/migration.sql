ALTER TABLE "Post" ADD COLUMN "maxDelivery" JSONB;
-- Pre-guard attempts cannot be proven unsent. Quarantine existing MAX work.
UPDATE "Post" p SET "maxDelivery" = '{"state":"STARTED","attempt":0,"reason":"legacy-unverified"}'::jsonb,
 "state" = 'ERROR', "error" = 'MAX delivery requires operator review (legacy attempt)'
FROM "Integration" i WHERE p."integrationId" = i.id AND i."providerIdentifier" = 'max'
AND p.state IN ('QUEUE', 'PUBLISHING', 'ERROR');
