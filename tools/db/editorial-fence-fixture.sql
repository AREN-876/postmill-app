\set ON_ERROR_STOP on
-- Minimal pre-migration fixture with the exact fields/types used by the fence.
-- Full Prisma schema reconstruction/drift is independently covered by Test CI.
CREATE TYPE "State" AS ENUM ('QUEUE','PUBLISHED','ERROR','DRAFT','PUBLISHING');
CREATE TABLE "Integration" (
 id text PRIMARY KEY, "organizationId" text NOT NULL, "providerIdentifier" text NOT NULL,
 disabled boolean NOT NULL DEFAULT false, "refreshNeeded" boolean NOT NULL DEFAULT false,
 "deletedAt" timestamp(3)
);
CREATE TABLE "Campaign" (
 id text PRIMARY KEY, "organizationId" text NOT NULL, archived boolean NOT NULL DEFAULT false,
 "deletedAt" timestamp(3)
);
CREATE TABLE "Post" (
 id text PRIMARY KEY, "organizationId" text NOT NULL, "integrationId" text NOT NULL REFERENCES "Integration"(id),
 "group" text NOT NULL, "state" "State" NOT NULL DEFAULT 'QUEUE', "campaignId" text REFERENCES "Campaign"(id),
 "parentPostId" text REFERENCES "Post"(id), "intervalInDays" integer, "deletedAt" timestamp(3),
 "releaseId" text, "releaseURL" text, "approvalStatus" text, "approvedAt" timestamp(3), "approvedById" text,
 "maxScheduleRevision" integer NOT NULL DEFAULT 0, "publishDate" timestamp(3) NOT NULL DEFAULT now(),
 -- Match the real Prisma Post title column: catch PL/pgSQL name ambiguity in cross-DB CI.
 content text NOT NULL DEFAULT 'fixture', title text, settings text, image text, "maxTarget" jsonb,
 "updatedAt" timestamp(3) NOT NULL DEFAULT now(), "commentCount" integer NOT NULL DEFAULT 0,
 "lastViews" double precision, "lastLikes" double precision, "lastComments" double precision
);
INSERT INTO "Integration"(id,"organizationId","providerIdentifier",disabled) VALUES
 ('max-a','org-a','max',false),('max-b','org-b','max',false),('other','org-a','telegram',false),('disabled','org-a','max',true);
INSERT INTO "Campaign"(id,"organizationId") VALUES ('campaign-a','org-a'),('campaign-b','org-b');
INSERT INTO "Post"(id,"organizationId","integrationId","group","state",content) VALUES
 ('ordinary','org-a','max-a','ordinary-group','QUEUE','existing'),
 ('ordinary-sibling','org-a','max-a','ordinary-group','DRAFT','existing sibling');
CREATE TEMP TABLE old_posts AS SELECT to_jsonb(p) value FROM "Post" p;
