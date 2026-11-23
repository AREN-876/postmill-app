-- One test-only, pre-review installation of the final Editorial text artifact.
-- Preserve the immutable original admission receipt and the 06A DRAFT fence.
-- No release, schedule, native approval or publication permission is added.
BEGIN;

CREATE TABLE "EditorialTextInstall" (
  "postId" TEXT NOT NULL PRIMARY KEY,
  request JSONB NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditorialTextInstall_postId_fkey" FOREIGN KEY ("postId")
    REFERENCES "EditorialDraftReceipt"("postId") ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT "EditorialTextInstall_shape" CHECK (
    jsonb_typeof(request) = 'object'
    AND octet_length(request::text) <= 100000
    AND request ?& ARRAY['schema_version','task_id','scope','text','content','firstPart','continuationText']
    AND request - ARRAY['schema_version','task_id','scope','text','content','firstPart','continuationText'] = '{}'::jsonb
    AND request->'schema_version' = '1'::jsonb
    AND request->'text'->'revision' = '1'::jsonb
    AND request->'text'->>'sha256' = encode(sha256(convert_to((request->'content')::text,'UTF8')),'hex')
    AND jsonb_typeof(request->'content'->'parts') = 'array'
    AND jsonb_array_length(request->'content'->'parts') = 3
    AND request->>'firstPart' = (request->'content'->>'title') || E'\n\n' || (request->'content'->'parts'->>0)
    AND request->>'continuationText' =
      (request->'content'->'parts'->>1) || E'\n────────────────────────\n' || (request->'content'->'parts'->>2)
    AND "sourceHash" ~ '^[0-9a-f]{64}$'
  )
);
CREATE TRIGGER "EditorialTextInstall_immutable_v1"
  BEFORE UPDATE OR DELETE ON "EditorialTextInstall"
  FOR EACH ROW EXECUTE FUNCTION postmill_editorial_decision_immutable_v1();

-- The managed Post may change only content/settings, only from the immutable
-- initial receipt to the one installed artifact, and only before review.
-- The original 06A fence remains in effect for all other mutations.
CREATE OR REPLACE FUNCTION postmill_editorial_draft_fence_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE v_initial jsonb; v_final jsonb;
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
   -- No session-variable bypass: the immutable installation ledger is the
   -- only permission for this exact one-time native content transition.
   IF (to_jsonb(NEW)-ARRAY['content','settings','updatedAt','commentCount','lastViews','lastLikes','lastComments'])
        IS NOT DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['content','settings','updatedAt','commentCount','lastViews','lastLikes','lastComments'])
      AND (NEW.content,NEW.settings) IS DISTINCT FROM (OLD.content,OLD.settings)
      AND NOT EXISTS (SELECT 1 FROM "EditorialReviewAnchor" a WHERE a."postId"=OLD.id)
      AND NOT EXISTS (SELECT 1 FROM "EditorialDecisionOutbox" o WHERE o."postId"=OLD.id)
      AND NOT EXISTS (SELECT 1 FROM "EditorialRelease" r WHERE r."sourcePostId"=OLD.id)
   THEN
     SELECT r.request,i.request INTO v_initial,v_final
     FROM "EditorialDraftReceipt" r JOIN "EditorialTextInstall" i
       ON i."postId"=r."postId"
     WHERE r."postId"=OLD.id;
     IF FOUND AND
       OLD.content IS NOT DISTINCT FROM v_initial->>'firstPart' AND
       OLD.settings::jsonb IS NOT DISTINCT FROM jsonb_build_object(
         '__type','max','mode','story','continuationText',v_initial->>'continuationText') AND
       v_final->'scope' IS NOT DISTINCT FROM v_initial->'scope' AND
       v_final->>'task_id' IS NOT DISTINCT FROM OLD."editorialTaskId" AND
       NEW.content IS NOT DISTINCT FROM v_final->>'firstPart' AND
       NEW.settings::jsonb IS NOT DISTINCT FROM jsonb_build_object(
         '__type','max','mode','story','continuationText',v_final->>'continuationText')
     THEN RETURN NEW; END IF;
   END IF;
   RAISE EXCEPTION 'EDITORIAL_MANAGED_DRAFT_FROZEN' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW."editorialTaskId" IS NOT NULL THEN
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

-- The historical admission remains immutable. Machine/human reconciliation
-- returns the installed artifact when one exists, never mixed revisions.
CREATE OR REPLACE FUNCTION postmill_read_editorial_draft_v1(s jsonb, task text, target text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE p "Post"%ROWTYPE; initial jsonb; effective jsonb; snap jsonb;
 current_target jsonb; settings jsonb; installed jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(s->>'org_id',task)::text,0));
 SELECT a.* INTO p FROM "Post" a JOIN "EditorialDraftReceipt" r ON r."postId"=a.id
 WHERE a."organizationId"=s->>'org_id' AND a."editorialTaskId"=task AND r.request->'scope'=s
 FOR SHARE OF a;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT r.request,r."targetSnapshot",i.request INTO initial,snap,installed
 FROM "EditorialDraftReceipt" r LEFT JOIN "EditorialTextInstall" i ON i."postId"=r."postId"
 WHERE r."postId"=p.id;
 effective:=coalesce(installed,initial);
 current_target:=postmill_check_editorial_target_v1(s,target);
 IF snap IS NULL OR snap IS DISTINCT FROM current_target THEN
  RAISE EXCEPTION 'EDITORIAL_TARGET_CHANGED' USING ERRCODE='55000'; END IF;
 settings:=p.settings::jsonb;
 IF (initial->>'task_id'=task AND initial->'scope'=s
 AND initial->'text'->>'sha256'=encode(sha256(convert_to((initial->'content')::text,'UTF8')),'hex')
 AND (installed IS NULL OR (
   installed->>'task_id'=task AND installed->'scope'=s
   AND (SELECT i."sourceHash" FROM "EditorialTextInstall" i WHERE i."postId"=p.id)=initial->'text'->>'sha256'))
 AND p."editorialProfileRef"=s->>'profile_ref' AND p."integrationId"=s->>'integration_id'
 AND p."campaignId"=s->>'campaign_id' AND p."group"='editorial-v1-'||p.id AND p.state='DRAFT'
 AND p."approvalStatus"='pending' AND p."parentPostId" IS NULL AND p."deletedAt" IS NULL
 AND p."intervalInDays" IS NULL AND p."releaseId" IS NULL AND p."releaseURL" IS NULL
 AND p."approvedById" IS NULL AND p."approvedAt" IS NULL AND p."maxScheduleRevision"=0
 AND p.content=effective->>'firstPart' AND p.image='[]'
 AND settings=jsonb_build_object('__type','max','mode','story','continuationText',effective->>'continuationText')
 AND effective->'text'->>'sha256'=encode(sha256(convert_to((effective->'content')::text,'UTF8')),'hex')
 AND NOT EXISTS(SELECT 1 FROM "Post" child WHERE child.id<>p.id
  AND (child."parentPostId"=p.id OR child."group"=p."group"))) IS NOT TRUE THEN
  RAISE EXCEPTION 'EDITORIAL_DRAFT_MISMATCH' USING ERRCODE='55000';
 END IF;
 RETURN jsonb_build_object('receipt',jsonb_build_object(
  'schema_version',1,'binding',jsonb_build_object('task_id',task,'profile_ref',s->>'profile_ref',
   'org_id',s->>'org_id','integration_id',s->>'integration_id','post_id',p.id,'group_id',p."group",'is_test',true),
  'channel_id',s->'channel_id','campaign_id',s->>'campaign_id','image_mode',s->'image_mode','text',effective->'text',
  'publishable',false,'dispatch_authorized',false),
  'state','DRAFT','native_verified',true,'review_acknowledged',false);
END $fn$;

-- Single idempotent install. The scope and normalized content must already
-- have passed the dedicated machine bearer + canonical JSON ingress validator.
-- The final text is revision 1 of Editorial review, replacing test-only seed.
CREATE FUNCTION postmill_install_editorial_text_v1(p jsonb, target text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE initial jsonb; verified jsonb; previous jsonb; pid text;
 current_install jsonb; is_new boolean:=false; s jsonb; task text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR
   octet_length(p::text)>100000 OR
   NOT(p ?& ARRAY['schema_version','task_id','scope','text','content','firstPart','continuationText']) OR
   p-ARRAY['schema_version','task_id','scope','text','content','firstPart','continuationText']<>'{}'::jsonb OR
   p->'schema_version'<>'1'::jsonb OR p->'text'->'revision'<>'1'::jsonb OR
   p->'scope'->'is_test'<>'true'::jsonb OR p->'scope'->>'image_mode'<>'disabled' OR
   p->'text'->>'sha256' IS DISTINCT FROM encode(sha256(convert_to((p->'content')::text,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'EDITORIAL_INSTALL_INVALID' USING ERRCODE='22023'; END IF;
 s:=p->'scope'; task:=p->>'task_id';
 -- Immutable target/org/task binding is checked by the reader.
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL THEN RAISE EXCEPTION 'EDITORIAL_DRAFT_NOT_FOUND' USING ERRCODE='55000'; END IF;
 pid:=verified->'receipt'->'binding'->>'post_id';
 SELECT r.request,i.request INTO initial,current_install
 FROM "EditorialDraftReceipt" r LEFT JOIN "EditorialTextInstall" i ON i."postId"=r."postId"
 WHERE r."postId"=pid;
 IF current_install IS NOT NULL THEN
   IF current_install IS DISTINCT FROM p THEN
     RAISE EXCEPTION 'EDITORIAL_INSTALL_CONFLICT' USING ERRCODE='55000'; END IF;
   RETURN verified || jsonb_build_object('installed',false);
 END IF;
 IF (p->>'task_id'=initial->>'task_id'
   AND s=initial->'scope'
   AND p->'text' IS DISTINCT FROM initial->'text'
   AND p->>'firstPart'=(p->'content'->>'title')||E'\n\n'||(p->'content'->'parts'->>0)
   AND p->>'continuationText'=(p->'content'->'parts'->>1)||E'\n────────────────────────\n'||(p->'content'->'parts'->>2)
   AND (p->'content'->'parts'->>0) IS NOT NULL
   AND (p->'content'->'parts'->>1) IS NOT NULL
   AND (p->'content'->'parts'->>2) IS NOT NULL
   AND length(p->>'firstPart')<=4000
   AND NOT EXISTS(SELECT 1 FROM "EditorialReviewAnchor" a WHERE a."postId"=pid)
   AND NOT EXISTS(SELECT 1 FROM "EditorialDecisionOutbox" o WHERE o."postId"=pid)
   AND NOT EXISTS(SELECT 1 FROM "EditorialRelease" r WHERE r."sourcePostId"=pid)
 ) IS NOT TRUE THEN RAISE EXCEPTION 'EDITORIAL_INSTALL_CONFLICT' USING ERRCODE='55000'; END IF;
 INSERT INTO "EditorialTextInstall"("postId",request,"sourceHash")
 VALUES(pid,p,initial->'text'->>'sha256');
 UPDATE "Post" SET content=p->>'firstPart',
   settings=jsonb_build_object('__type','max','mode','story',
      'continuationText',p->>'continuationText')::text,
   "updatedAt"=now()
 WHERE id=pid AND state='DRAFT';
 IF NOT FOUND THEN RAISE EXCEPTION 'EDITORIAL_INSTALL_CONFLICT' USING ERRCODE='55000'; END IF;
 previous:=verified;
 verified:=postmill_read_editorial_draft_v1(s,task,target);
 IF verified IS NULL OR verified->'receipt'->'text' IS DISTINCT FROM p->'text'
   OR verified->'receipt'->'binding' IS DISTINCT FROM previous->'receipt'->'binding'
 THEN RAISE EXCEPTION 'EDITORIAL_INSTALL_MISMATCH' USING ERRCODE='55000'; END IF;
 RETURN verified || jsonb_build_object('installed',true);
END $fn$;

-- Human review must render the installed artifact, never the obsolete seed.
CREATE OR REPLACE FUNCTION postmill_read_editorial_human_v1(org text, pid text, task text, target text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path=pg_catalog,public,pg_temp AS $fn$
DECLARE s jsonb; draft jsonb; content jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'EDITORIAL_REQUIRES_READ_COMMITTED' USING ERRCODE='25000'; END IF;
 IF org IS NULL OR org !~ '^[A-Za-z0-9_.:-]{1,200}$'
   OR pid IS NULL OR pid !~ '^[0-9a-f]{32}$'
   OR task IS NULL OR task !~ '^[1-9][0-9]{0,18}$'
   OR (length(task)=19 AND task>'9223372036854775807')
   OR target IS NULL OR length(target) NOT BETWEEN 1 AND 200 THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_INVALID' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(org,task)::text,0));
 SELECT r.request->'scope',coalesce(i.request->'content',r.request->'content') INTO s,content
 FROM "Post" p JOIN "EditorialDraftReceipt" r ON r."postId"=p.id
 LEFT JOIN "EditorialTextInstall" i ON i."postId"=p.id
 WHERE p.id=pid AND p."organizationId"=org AND p."editorialTaskId"=task
  AND r.request->'scope'->>'org_id'=org
  AND r.request->'scope'->'is_test'='true'::jsonb
  AND r."targetSnapshot"->>'internalId'=target
 FOR SHARE OF p;
 IF NOT FOUND THEN RETURN NULL; END IF;
 draft:=postmill_read_editorial_review_v1(s,task,target);
 IF draft IS NULL OR draft->'receipt'->'binding'->>'post_id' IS DISTINCT FROM pid
  OR draft->'receipt'->'binding'->>'org_id' IS DISTINCT FROM org
  OR draft->'receipt'->'binding'->>'task_id' IS DISTINCT FROM task THEN
  RAISE EXCEPTION 'EDITORIAL_HUMAN_BINDING_CHANGED' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('post_id',pid,'task_id',task,'content',content,
   'receipt',draft->'receipt','review',draft->'review',
   'review_acknowledged',draft->'review_acknowledged',
   'remote_current_verified',false,'dispatch_authorized',false,'publishable',false);
END $fn$;

REVOKE ALL ON "EditorialTextInstall" FROM PUBLIC;
REVOKE ALL ON FUNCTION postmill_install_editorial_text_v1(jsonb,text) FROM PUBLIC;
COMMIT;
