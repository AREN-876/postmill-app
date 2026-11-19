-- 06B-2A: an inactive, invoker-only persistence boundary.
BEGIN;
CREATE TABLE "EditorialDraftReceipt" (
  "postId" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialDraftReceipt_pkey" PRIMARY KEY ("postId"),
  CONSTRAINT "EditorialDraftReceipt_postId_fkey" FOREIGN KEY ("postId")
    REFERENCES "Post"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "EditorialDraftReceipt_request_size" CHECK (
    jsonb_typeof(request)='object' AND octet_length(request::text)<=100000)
);

CREATE FUNCTION postmill_editorial_receipt_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
BEGIN
  RAISE EXCEPTION 'EDITORIAL_RECEIPT_IMMUTABLE' USING ERRCODE='55000';
END $fn$;
CREATE TRIGGER "EditorialDraftReceipt_immutable_v1"
 BEFORE UPDATE OR DELETE ON "EditorialDraftReceipt"
 FOR EACH ROW EXECUTE FUNCTION postmill_editorial_receipt_immutable_v1();

-- This is NOT authentication: p is the prepared output of the trusted
-- 06B-1 admission boundary. No direct database access for the machine client.
-- Require read committed for visibility after the per-task transaction lock.
CREATE FUNCTION postmill_create_editorial_draft_v1(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE
 s jsonb; c jsonb; t jsonb; task text; org text; integration text; campaign text;
 profile text; post_id text; group_id text; old_request jsonb; created boolean:=false;
 first_part text; continuation text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000';
 END IF;
 IF (jsonb_typeof(p)='object' AND octet_length(p::text)<=100000
  AND p ?& ARRAY['schema_version','task_id','scope','text','content','firstPart','continuationText']
  AND p-ARRAY['schema_version','task_id','scope','text','content','firstPart','continuationText']='{}'::jsonb
  AND p->'schema_version'='1'::jsonb AND jsonb_typeof(p->'task_id')='string'
  AND jsonb_typeof(p->'firstPart')='string' AND jsonb_typeof(p->'continuationText')='string'
  AND jsonb_typeof(p->'scope')='object' AND jsonb_typeof(p->'content')='object'
  AND jsonb_typeof(p->'text')='object') IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_PREPARED_REQUEST' USING ERRCODE='22023';
 END IF;
 s:=p->'scope'; c:=p->'content'; t:=p->'text'; task:=p->>'task_id';
 org:=s->>'org_id'; integration:=s->>'integration_id'; campaign:=s->>'campaign_id'; profile:=s->>'profile_ref';
 IF (s ?& ARRAY['org_id','integration_id','campaign_id','channel_id','profile_ref','is_test','image_mode']
  AND s-ARRAY['org_id','integration_id','campaign_id','channel_id','profile_ref','is_test','image_mode']='{}'::jsonb
  AND NOT EXISTS (SELECT 1 FROM jsonb_each(s) e WHERE e.key<>'is_test' AND jsonb_typeof(e.value)<>'string')
  AND s->'is_test'='true'::jsonb
  AND task ~ '^[1-9][0-9]{0,18}$'
  AND CASE WHEN task ~ '^[1-9][0-9]{0,18}$' THEN task::numeric<=9223372036854775807 ELSE false END
  AND s->>'channel_id' ~ '^[1-9][0-9]{0,18}$'
  AND CASE WHEN s->>'channel_id' ~ '^[1-9][0-9]{0,18}$' THEN (s->>'channel_id')::numeric<=9223372036854775807 ELSE false END
  AND org ~ '^[A-Za-z0-9_.:-]{1,200}$'
  AND integration ~ '^[A-Za-z0-9_.:-]{1,200}$' AND integration NOT LIKE 'fixture:%'
  AND campaign ~ '^[A-Za-z0-9_.:-]{1,200}$'
  AND profile ~ '^[a-z][a-z0-9_-]{0,63}@v[1-9][0-9]{0,8}$'
  AND s->>'image_mode' IN ('after_text_approval','automatic','manual','disabled')
  AND c ?& ARRAY['title','parts'] AND c-ARRAY['title','parts']='{}'::jsonb
  AND jsonb_typeof(c->'title')='string' AND jsonb_typeof(c->'parts')='array'
  AND t ?& ARRAY['revision','sha256'] AND t-ARRAY['revision','sha256']='{}'::jsonb
  AND t->'revision'='1'::jsonb AND jsonb_typeof(t->'sha256')='string') IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_PREPARED_REQUEST' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(c->'parts')<>3
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(c->'parts') v WHERE jsonb_typeof(v)<>'string')
 OR (t->>'sha256') IS DISTINCT FROM encode(sha256(convert_to(c::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_ARTIFACT' USING ERRCODE='22023';
 END IF;
 -- Reconstruct native mapping in PostgreSQL, do not trust duplicated strings.
 first_part:=(c->>'title')||E'\n\n'||(c->'parts'->>0);
 continuation:=(c->'parts'->>1)||E'\n'||'────────────────────────'||E'\n'||(c->'parts'->>2);
 IF first_part IS DISTINCT FROM p->>'firstPart'
 OR continuation IS DISTINCT FROM p->>'continuationText'
 OR length(c->>'title') NOT BETWEEN 1 AND 160
 OR length(first_part)>4000
 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(c->'parts') v
   WHERE v !~ '[^[:space:]]' OR length(v)>4000) THEN
  RAISE EXCEPTION 'EDITORIAL_INVALID_ARTIFACT' USING ERRCODE='22023';
 END IF;
 -- JS admission above enforces full UTF-16/markup/control/divider rules.
 -- Recheck actual target rows under lock. The authoritative test-channel
 -- mapping is still a separate activation prerequisite, not inferred here.
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,task)::text,0));
 PERFORM 1 FROM "Integration" i WHERE i.id=integration AND i."organizationId"=org
  AND i."providerIdentifier"='max' AND NOT i.disabled AND NOT i."refreshNeeded"
  AND NOT i."inBetweenSteps" AND i."deletedAt" IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_TARGET_UNAVAILABLE' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM "Campaign" ca WHERE ca.id=campaign AND ca."organizationId"=org
  AND NOT ca.archived AND ca."deletedAt" IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_TARGET_UNAVAILABLE' USING ERRCODE='55000'; END IF;

 SELECT a.id,a."group",r.request INTO post_id,group_id,old_request
 FROM "Post" a LEFT JOIN "EditorialDraftReceipt" r ON r."postId"=a.id
 WHERE a."organizationId"=org AND a."editorialTaskId"=task FOR SHARE OF a;
 IF FOUND THEN
  IF old_request IS DISTINCT FROM p THEN
   RAISE EXCEPTION 'EDITORIAL_DRAFT_CONFLICT' USING ERRCODE='55000';
  END IF;
 ELSE
  -- UUID entropy encoded as 32 lowercase hex characters, compatible with
  -- this repository's isCuid route validator. Never accept caller post IDs.
  post_id:=replace(gen_random_uuid()::text,'-',''); group_id:='editorial-v1-'||post_id;
  INSERT INTO "Post"(id,"organizationId","integrationId","group","state","campaignId","approvalStatus",
    content,settings,image,"editorialTaskId","editorialProfileRef","publishDate","updatedAt","creationMethod")
  VALUES(post_id,org,integration,group_id,'DRAFT',campaign,'pending',first_part,
    jsonb_build_object('__type','max','mode','story','continuationText',continuation)::text,
    '[]',task,profile,now(),now(),'API');
  INSERT INTO "EditorialDraftReceipt"("postId",request) VALUES(post_id,p);
  created:=true;
 END IF;
 RETURN jsonb_build_object('created',created,'receipt',jsonb_build_object(
  'schema_version',1,'binding',jsonb_build_object('task_id',task,'profile_ref',profile,
   'org_id',org,'integration_id',integration,'post_id',post_id,'group_id',group_id,'is_test',true),
  'channel_id',s->'channel_id','campaign_id',campaign,'image_mode',s->'image_mode','text',t,
  'publishable',false,'dispatch_authorized',false));
END $fn$;

REVOKE ALL ON FUNCTION postmill_create_editorial_draft_v1(jsonb) FROM PUBLIC;
COMMIT;
