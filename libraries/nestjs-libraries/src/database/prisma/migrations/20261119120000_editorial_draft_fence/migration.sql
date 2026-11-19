-- 06A: opt-in managed draft fence, not an activation or publishing grant.
-- Existing posts keep NULL identity. Reserved group namespace prevents a
-- managed draft sharing a native group, even under concurrent writes.
BEGIN;
ALTER TABLE "Post" ADD COLUMN "editorialTaskId" TEXT,
                   ADD COLUMN "editorialProfileRef" TEXT;
CREATE UNIQUE INDEX "Post_organizationId_editorialTaskId_key"
  ON "Post"("organizationId", "editorialTaskId");
ALTER TABLE "Post" ADD CONSTRAINT "Post_editorial_draft_only_v1"
CHECK ((
 ("editorialTaskId" IS NULL AND "editorialProfileRef" IS NULL
  AND "group" NOT LIKE 'editorial-v1-%')
 OR
 ("editorialTaskId" ~ '^[1-9][0-9]{0,18}$'
  AND CASE WHEN "editorialTaskId" ~ '^[1-9][0-9]{0,18}$'
       THEN "editorialTaskId"::numeric <= 9223372036854775807 ELSE false END
  AND "editorialProfileRef" ~ '^[a-z][a-z0-9_-]{0,63}@v[1-9][0-9]{0,8}$'
  AND "group" = 'editorial-v1-' || id
  AND "state" = 'DRAFT' AND "campaignId" IS NOT NULL
  AND "parentPostId" IS NULL AND "intervalInDays" IS NULL
  AND "deletedAt" IS NULL AND "releaseId" IS NULL AND "releaseURL" IS NULL
  AND "approvalStatus" = 'pending' AND "approvedById" IS NULL
  AND "approvedAt" IS NULL AND "maxScheduleRevision" = 0)
) IS TRUE);

-- Compare the whole row, ignoring only explicitly operational fields.
-- Do not add a session-variable bypass: future revision-aware transactions
-- replace the fence with an audited transition guard before any activation.
CREATE FUNCTION postmill_editorial_draft_fence_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."editorialTaskId" IS NOT NULL THEN
   RAISE EXCEPTION 'EDITORIAL_MANAGED_DRAFT_FROZEN' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW."editorialTaskId",NEW."editorialProfileRef") IS DISTINCT FROM
     (OLD."editorialTaskId",OLD."editorialProfileRef") THEN
   RAISE EXCEPTION 'EDITORIAL_BINDING_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  IF OLD."editorialTaskId" IS NOT NULL AND
     (to_jsonb(NEW)-ARRAY['updatedAt','commentCount','lastViews','lastLikes','lastComments'])
       IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['updatedAt','commentCount','lastViews','lastLikes','lastComments']) THEN
   RAISE EXCEPTION 'EDITORIAL_MANAGED_DRAFT_FROZEN' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW."editorialTaskId" IS NOT NULL THEN
  -- Only a new draft may be bound. Never retrofit a scheduled post.
  IF NOT EXISTS (
    SELECT 1 FROM public."Integration" i WHERE i.id=NEW."integrationId"
     AND i."organizationId"=NEW."organizationId" AND i."providerIdentifier"='max'
     AND NOT i.disabled AND NOT i."refreshNeeded" AND i."deletedAt" IS NULL)
   OR NOT EXISTS (
    SELECT 1 FROM public."Campaign" c WHERE c.id=NEW."campaignId"
     AND c."organizationId"=NEW."organizationId" AND NOT c.archived AND c."deletedAt" IS NULL)
   OR NEW.settings::jsonb->>'__type' IS DISTINCT FROM 'max'
   OR NEW.settings::jsonb->>'mode' IS DISTINCT FROM 'story' THEN
   RAISE EXCEPTION 'EDITORIAL_BINDING_INVALID' USING ERRCODE='22023';
  END IF;
 END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER "Post_editorial_draft_fence_v1"
 BEFORE INSERT OR UPDATE OR DELETE ON "Post"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_draft_fence_v1();
COMMIT;
