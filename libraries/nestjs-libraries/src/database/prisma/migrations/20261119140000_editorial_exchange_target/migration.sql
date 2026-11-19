-- 06B-2B: exact MAX target evidence and scoped reconciliation, inactive.
BEGIN;
ALTER TABLE "EditorialDraftReceipt" ADD COLUMN "targetSnapshot" JSONB;
-- Compare the encrypted token hash only internally; never return it.
CREATE FUNCTION postmill_editorial_capture_target_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
 IF NEW."targetSnapshot" IS NOT NULL THEN
  RAISE EXCEPTION 'EDITORIAL_CALLER_TARGET_FORBIDDEN' USING ERRCODE='22023';
 END IF;
 SELECT jsonb_build_object('internalId',i."internalId",'providerVersion',i."providerVersion",
  'providerConfigId',i."providerConfigId",'tokenHash',encode(sha256(convert_to(i.token,'UTF8')),'hex'))
 INTO NEW."targetSnapshot"
 FROM "Post" p JOIN "Integration" i ON i.id=p."integrationId" AND i."organizationId"=p."organizationId"
 WHERE p.id=NEW."postId" AND p."editorialTaskId" IS NOT NULL
 AND i."providerIdentifier"='max' AND NOT i.disabled AND NOT i."refreshNeeded"
 AND NOT i."inBetweenSteps" AND i."deletedAt" IS NULL FOR SHARE OF i;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_TARGET_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER "EditorialDraftReceipt_capture_target_v1" BEFORE INSERT ON "EditorialDraftReceipt"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_capture_target_v1();

-- Invoker-only. Scope/target originate in trusted machine configuration.
CREATE FUNCTION postmill_check_editorial_target_v1(s jsonb, target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE result jsonb;
BEGIN
 IF (jsonb_typeof(s)='object' AND s->'is_test'='true'::jsonb
 AND target IS NOT NULL AND length(target) BETWEEN 1 AND 200) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_SCOPE' USING ERRCODE='22023';
 END IF;
 SELECT jsonb_build_object('internalId',i."internalId",'providerVersion',i."providerVersion",
  'providerConfigId',i."providerConfigId",'tokenHash',encode(sha256(convert_to(i.token,'UTF8')),'hex'))
 INTO result FROM "Integration" i
 WHERE i.id=s->>'integration_id' AND i."organizationId"=s->>'org_id'
  AND i."internalId"=target AND i."providerIdentifier"='max'
  AND NOT i.disabled AND NOT i."refreshNeeded" AND NOT i."inBetweenSteps" AND i."deletedAt" IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_TARGET_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM "Campaign" ca WHERE ca.id=s->>'campaign_id' AND ca."organizationId"=s->>'org_id'
  AND NOT ca.archived AND ca."deletedAt" IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_TARGET_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 RETURN result;
END $fn$;

CREATE FUNCTION postmill_read_editorial_draft_v1(s jsonb, task text, target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE p "Post"%ROWTYPE; req jsonb; snap jsonb; current_target jsonb; settings jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(s->>'org_id',task)::text,0));
 -- Scope mismatch/not found indistinguishable.
 SELECT a.* INTO p FROM "Post" a JOIN "EditorialDraftReceipt" r ON r."postId"=a.id
 WHERE a."organizationId"=s->>'org_id' AND a."editorialTaskId"=task AND r.request->'scope'=s
 FOR SHARE OF a;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT r.request,r."targetSnapshot" INTO req,snap FROM "EditorialDraftReceipt" r WHERE r."postId"=p.id;
 current_target:=postmill_check_editorial_target_v1(s,target);
 IF snap IS NULL OR snap IS DISTINCT FROM current_target THEN
  RAISE EXCEPTION 'EDITORIAL_TARGET_CHANGED' USING ERRCODE='55000'; END IF;
 settings:=p.settings::jsonb;
 IF (p."editorialProfileRef"=s->>'profile_ref' AND p."integrationId"=s->>'integration_id'
 AND p."campaignId"=s->>'campaign_id' AND p."group"='editorial-v1-'||p.id AND p.state='DRAFT'
 AND p."approvalStatus"='pending' AND p."parentPostId" IS NULL AND p."deletedAt" IS NULL
 AND p."intervalInDays" IS NULL AND p."releaseId" IS NULL AND p."releaseURL" IS NULL
 AND p."approvedById" IS NULL AND p."approvedAt" IS NULL AND p."maxScheduleRevision"=0
 AND p.content=req->>'firstPart' AND p.image='[]'
 AND settings=jsonb_build_object('__type','max','mode','story','continuationText',req->>'continuationText')
 AND req->'text'->>'sha256'=encode(sha256(convert_to((req->'content')::text,'UTF8')),'hex')
 AND NOT EXISTS(SELECT 1 FROM "Post" child WHERE child.id<>p.id
  AND (child."parentPostId"=p.id OR child."group"=p."group"))) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_DRAFT_MISMATCH' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('receipt',jsonb_build_object(
  'schema_version',1,'binding',jsonb_build_object('task_id',task,'profile_ref',s->>'profile_ref',
   'org_id',s->>'org_id','integration_id',s->>'integration_id','post_id',p.id,'group_id',p."group",'is_test',true),
  'channel_id',s->'channel_id','campaign_id',s->>'campaign_id','image_mode',s->'image_mode','text',req->'text',
  'publishable',false,'dispatch_authorized',false),
  'state','DRAFT','native_verified',true,'review_acknowledged',false);
END $fn$;

CREATE FUNCTION postmill_exchange_create_v1(p jsonb, target text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE initial jsonb; verified jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p->'scope'->>'org_id',p->>'task_id')::text,0));
 PERFORM postmill_check_editorial_target_v1(p->'scope',target);
 initial:=postmill_create_editorial_draft_v1(p);
 verified:=postmill_read_editorial_draft_v1(p->'scope',p->>'task_id',target);
 IF verified IS NULL OR verified->'receipt' IS DISTINCT FROM initial->'receipt' THEN
  RAISE EXCEPTION 'EDITORIAL_DRAFT_MISMATCH' USING ERRCODE='55000'; END IF;
 RETURN verified||jsonb_build_object('created',initial->'created');
END $fn$;
REVOKE ALL ON FUNCTION postmill_check_editorial_target_v1(jsonb,text),
 postmill_read_editorial_draft_v1(jsonb,text,text),postmill_exchange_create_v1(jsonb,text) FROM PUBLIC;
COMMIT;
