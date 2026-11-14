ALTER TABLE "Post" ADD COLUMN "maxTarget" JSONB;
-- Freeze existing MAX destinations during migration; no plaintext token is copied.
UPDATE "Post" p SET "maxTarget" = jsonb_build_object(
 'integrationId', i.id, 'internalId', i."internalId", 'providerConfigId', i."providerConfigId",
 'version', i."providerVersion", 'tokenHash', encode(sha256(convert_to(i.token, 'UTF8')), 'hex'))
FROM "Integration" i WHERE i.id = p."integrationId" AND i."providerIdentifier" = 'max';
