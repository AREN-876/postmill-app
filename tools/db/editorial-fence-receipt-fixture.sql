\set ON_ERROR_STOP on
-- Extend the minimal 06A fixture with the canonical schema's fields used here.
ALTER TABLE "Integration" ADD COLUMN "inBetweenSteps" BOOLEAN NOT NULL DEFAULT false;
CREATE TYPE "CreationMethod" AS ENUM ('UNKNOWN','WEB','MCP','API','AUTOPOST','CLI');
ALTER TABLE "Post" ADD COLUMN "creationMethod" "CreationMethod" NOT NULL DEFAULT 'UNKNOWN';
