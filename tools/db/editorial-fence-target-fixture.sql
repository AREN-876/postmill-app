\set ON_ERROR_STOP on
ALTER TABLE "Integration" ADD COLUMN "internalId" TEXT NOT NULL DEFAULT 'test-channel';
ALTER TABLE "Integration" ADD COLUMN "providerVersion" TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE "Integration" ADD COLUMN "providerConfigId" TEXT;
ALTER TABLE "Integration" ADD COLUMN token TEXT NOT NULL DEFAULT 'synthetic-encrypted-token';
UPDATE "Integration" SET "internalId"='test-channel-b' WHERE id='max-b';
