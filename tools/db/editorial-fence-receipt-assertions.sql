\set ON_ERROR_STOP on
-- Temporary helper, not an application function. Real fixture uses PG hash.
CREATE FUNCTION pg_temp.prepared_draft(task text, org text DEFAULT 'org-a', integration text DEFAULT 'max-a',
 campaign text DEFAULT 'campaign-a', title text DEFAULT 'Тест') RETURNS jsonb LANGUAGE sql AS $$
 WITH c AS (SELECT jsonb_build_object('title',title,'parts',jsonb_build_array('One 😀','Two','Three')) v)
 SELECT jsonb_build_object('schema_version',1,'task_id',task,
 'scope',jsonb_build_object('org_id',org,'integration_id',integration,'campaign_id',campaign,
  'channel_id','42','profile_ref','life-stories@v5','is_test',true,'image_mode','after_text_approval'),
 'content',v,'text',jsonb_build_object('revision',1,'sha256',encode(sha256(convert_to(v::text,'UTF8')),'hex')),
 'firstPart',title||E'\n\n'||'One 😀','continuationText','Two'||E'\n'||'────────────────────────'||E'\n'||'Three')
 FROM c $$;
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('15'); a jsonb; b jsonb; id1 text; n bigint; bad jsonb;
BEGIN
 a:=postmill_create_editorial_draft_v1(p);
 b:=postmill_create_editorial_draft_v1(p);
 IF a->'created' IS DISTINCT FROM 'true'::jsonb OR b->'created' IS DISTINCT FROM 'false'::jsonb
 OR a->'receipt' IS DISTINCT FROM b->'receipt' OR a->'receipt'->'publishable' IS DISTINCT FROM 'false'::jsonb
 OR a->'receipt'->'dispatch_authorized' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'bad receipt/replay'; END IF;
 id1:=a->'receipt'->'binding'->>'post_id';
 IF id1 !~ '^[a-f0-9]{32}$' OR NOT EXISTS (
  SELECT 1 FROM "Post" x JOIN "EditorialDraftReceipt" r ON r."postId"=x.id
  WHERE x.id=id1 AND x."group"='editorial-v1-'||id1 AND x."state"='DRAFT'
   AND x."approvalStatus"='pending' AND x."creationMethod"='API' AND x.image='[]'
   AND x.content=p->>'firstPart' AND x.settings::jsonb->>'continuationText'=p->>'continuationText'
   AND x."editorialTaskId"='15' AND r.request=p) THEN
  RAISE EXCEPTION 'incorrect stored draft'; END IF;
 SELECT count(*) INTO n FROM "Post";
 BEGIN
  PERFORM postmill_create_editorial_draft_v1(pg_temp.prepared_draft('15',title=>'Changed'));
  RAISE EXCEPTION 'changed request accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DRAFT_CONFLICT' THEN RAISE; END IF; END;
 BEGIN
  PERFORM postmill_create_editorial_draft_v1(pg_temp.prepared_draft('4'));
  RAISE EXCEPTION 'untracked 06A draft reused';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DRAFT_CONFLICT' THEN RAISE; END IF; END;
 FOREACH bad IN ARRAY ARRAY[
  pg_temp.prepared_draft('16',integration=>'max-b'),
  pg_temp.prepared_draft('16',campaign=>'campaign-b'),
  pg_temp.prepared_draft('16',integration=>'disabled')
 ] LOOP
  BEGIN PERFORM postmill_create_editorial_draft_v1(bad); RAISE EXCEPTION 'foreign/disabled target accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_UNAVAILABLE' THEN RAISE; END IF; END;
 END LOOP;
 FOREACH bad IN ARRAY ARRAY[
  p||'{"publishDate":"now"}'::jsonb,
  jsonb_set(pg_temp.prepared_draft('16'),'{scope,is_test}','false'),
  jsonb_set(pg_temp.prepared_draft('16'),'{text,sha256}',to_jsonb(repeat('0',64))),
  jsonb_set(pg_temp.prepared_draft('16'),'{firstPart}',to_jsonb('changed'::text))
 ] LOOP
  BEGIN PERFORM postmill_create_editorial_draft_v1(bad); RAISE EXCEPTION 'invalid input accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 END LOOP;
 UPDATE "Integration" SET "inBetweenSteps"=true WHERE id='max-a';
 BEGIN PERFORM postmill_create_editorial_draft_v1(p); RAISE EXCEPTION 'ineligible replay accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_UNAVAILABLE' THEN RAISE; END IF; END;
 UPDATE "Integration" SET "inBetweenSteps"=false WHERE id='max-a';
 BEGIN UPDATE "EditorialDraftReceipt" SET request='{}' WHERE "postId"=id1; RAISE EXCEPTION 'mutable receipt';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_RECEIPT_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN DELETE FROM "EditorialDraftReceipt" WHERE "postId"=id1; RAISE EXCEPTION 'deletable receipt';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_RECEIPT_IMMUTABLE' THEN RAISE; END IF; END;
 BEGIN UPDATE "Post" SET "state"='QUEUE' WHERE id=id1; RAISE EXCEPTION 'publication fence lost';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_MANAGED_DRAFT_FROZEN' THEN RAISE; END IF; END;
 IF (SELECT count(*) FROM "Post")<>n OR (SELECT count(*) FROM "EditorialDraftReceipt")<>1 THEN
  RAISE EXCEPTION 'unexpected writes after failed requests'; END IF;
 a:=postmill_create_editorial_draft_v1(pg_temp.prepared_draft('15','org-b','max-b','campaign-b'));
 IF a->'created' IS DISTINCT FROM 'true'::jsonb OR a->'receipt'->'binding'->>'post_id'=id1 THEN
  RAISE EXCEPTION 'cross org idempotency collision'; END IF;
END $$;
-- Check rollback of both records if the enclosing transaction fails.
BEGIN;
SELECT postmill_create_editorial_draft_v1(pg_temp.prepared_draft('99'))->>'created' AS created;
ROLLBACK;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM "Post" WHERE "editorialTaskId"='99')
 OR (SELECT count(*) FROM "EditorialDraftReceipt")<>2 THEN RAISE EXCEPTION 'partial commit'; END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_DRAFT_RECEIPT_OK';
