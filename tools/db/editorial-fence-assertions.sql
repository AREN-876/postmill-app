\set ON_ERROR_STOP on
DO $test$
DECLARE e text;
BEGIN
 IF EXISTS(SELECT value FROM old_posts EXCEPT SELECT to_jsonb(p)-ARRAY['editorialTaskId','editorialProfileRef'] FROM "Post" p)
 OR EXISTS(SELECT 1 FROM "Post" WHERE "editorialTaskId" IS NOT NULL OR "editorialProfileRef" IS NOT NULL) THEN
  RAISE EXCEPTION 'legacy rows mutated'; END IF;
 -- Native existing groups, approvals, edits and queue remain unchanged.
 UPDATE "Post" SET content='edited',"approvalStatus"='approved',"state"='QUEUE',"group"='new-native-group' WHERE id='ordinary';
 DELETE FROM "Post" WHERE id='ordinary-sibling';
 INSERT INTO "Post"(id,"organizationId","integrationId","group") VALUES ('native-new','org-a','other','new-native-group');
 INSERT INTO "Post"(id,"organizationId","integrationId","group","state","campaignId","approvalStatus",
  settings,"editorialTaskId","editorialProfileRef")
 VALUES ('managed','org-a','max-a','editorial-v1-managed','DRAFT','campaign-a','pending',
  '{"__type":"max","mode":"story"}','4','life-stories@v5');
 INSERT INTO "Post"(id,"organizationId","integrationId","group","state","campaignId","approvalStatus",
  settings,"editorialTaskId","editorialProfileRef")
 VALUES ('managed-b','org-b','max-b','editorial-v1-managed-b','DRAFT','campaign-b','pending',
  '{"__type":"max","mode":"story"}','4','life-stories@v5');
 UPDATE "Post" SET "commentCount"=1,"updatedAt"=now(),"lastViews"=2 WHERE id='managed';
 FOREACH e IN ARRAY ARRAY[
  'UPDATE "Post" SET "state"=''QUEUE'' WHERE id=''managed''',
  'UPDATE "Post" SET "state"=''PUBLISHING'' WHERE id=''managed''',
  'UPDATE "Post" SET "approvalStatus"=''approved'' WHERE id=''managed''',
  'UPDATE "Post" SET "approvalStatus"=''rejected'' WHERE id=''managed''',
  'UPDATE "Post" SET content=''new'' WHERE id=''managed''',
  'UPDATE "Post" SET settings=''{}'' WHERE id=''managed''',
  'UPDATE "Post" SET image=''[]'' WHERE id=''managed''',
  'UPDATE "Post" SET "group"=''new-group'' WHERE id=''managed''',
  'UPDATE "Post" SET "integrationId"=''other'' WHERE id=''managed''',
  'UPDATE "Post" SET "organizationId"=''org-b'' WHERE id=''managed''',
  'UPDATE "Post" SET "campaignId"=NULL WHERE id=''managed''',
  'UPDATE "Post" SET "intervalInDays"=1 WHERE id=''managed''',
  'UPDATE "Post" SET "publishDate"=now()+interval ''1 day'' WHERE id=''managed''',
  'UPDATE "Post" SET "maxScheduleRevision"=1 WHERE id=''managed''',
  'UPDATE "Post" SET "deletedAt"=now() WHERE id=''managed''',
  'DELETE FROM "Post" WHERE id=''managed'''
 ] LOOP
  BEGIN EXECUTE e; RAISE EXCEPTION 'unexpected allowed write: %',e;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'EDITORIAL_MANAGED_DRAFT_FROZEN' THEN RAISE; END IF;
  END;
 END LOOP;
 BEGIN
  UPDATE "Post" SET "editorialTaskId"=NULL,"editorialProfileRef"=NULL WHERE id='managed';
  RAISE EXCEPTION 'unexpected unbind';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'EDITORIAL_BINDING_IMMUTABLE' THEN RAISE; END IF;
 END;
 BEGIN
  UPDATE "Post" SET "editorialTaskId"='5',"editorialProfileRef"='life-stories@v5' WHERE id='ordinary';
  RAISE EXCEPTION 'unexpected retrofit';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'EDITORIAL_BINDING_IMMUTABLE' THEN RAISE; END IF;
 END;
 BEGIN
  INSERT INTO "Post"(id,"organizationId","integrationId","group") VALUES ('spoof','org-a','max-a','editorial-v1-managed');
  RAISE EXCEPTION 'reserved group allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE "Post" SET "group"='editorial-v1-managed' WHERE id='ordinary';
  RAISE EXCEPTION 'reserved group reassignment allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 -- Test the constraints on insert, not only trigger checks on updates.
 FOREACH e IN ARRAY ARRAY[
  '(''duplicate'',''org-a'',''max-a'',''editorial-v1-duplicate'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''4'',''life-stories@v5'')',
  '(''queue'',''org-a'',''max-a'',''editorial-v1-queue'',''QUEUE'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''5'',''life-stories@v5'')',
  '(''nullapproval'',''org-a'',''max-a'',''editorial-v1-nullapproval'',''DRAFT'',''campaign-a'',NULL,''{"__type":"max","mode":"story"}'',''5'',''life-stories@v5'')',
  '(''partial'',''org-a'',''max-a'',''editorial-v1-partial'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''5'',NULL)',
  '(''partial2'',''org-a'',''max-a'',''partial2-group'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',NULL,''life-stories@v5'')',
  '(''large'',''org-a'',''max-a'',''editorial-v1-large'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''9223372036854775808'',''life-stories@v5'')',
  '(''foreign'',''org-a'',''max-b'',''editorial-v1-foreign'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''5'',''life-stories@v5'')',
  '(''foreign-c'',''org-a'',''max-a'',''editorial-v1-foreign-c'',''DRAFT'',''campaign-b'',''pending'',''{"__type":"max","mode":"story"}'',''5'',''life-stories@v5'')',
  '(''nonmax'',''org-a'',''other'',''editorial-v1-nonmax'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''5'',''life-stories@v5'')',
  '(''disabled'',''org-a'',''disabled'',''editorial-v1-disabled'',''DRAFT'',''campaign-a'',''pending'',''{"__type":"max","mode":"story"}'',''5'',''life-stories@v5'')',
  '(''nostory'',''org-a'',''max-a'',''editorial-v1-nostory'',''DRAFT'',''campaign-a'',''pending'',''{}'',''5'',''life-stories@v5'')'
 ] LOOP
  BEGIN
   EXECUTE 'INSERT INTO "Post"(id,"organizationId","integrationId","group","state","campaignId","approvalStatus",settings,"editorialTaskId","editorialProfileRef") VALUES '||e;
   RAISE EXCEPTION 'unexpected valid insert: %',e;
  EXCEPTION WHEN check_violation OR unique_violation OR invalid_parameter_value THEN NULL; END;
 END LOOP;
 IF (SELECT count(*) FROM "Post" WHERE "editorialTaskId" IS NOT NULL)<>2
 OR (SELECT "state" FROM "Post" WHERE id='managed')<>'DRAFT'
 OR (SELECT "approvalStatus" FROM "Post" WHERE id='managed')<>'pending' THEN
  RAISE EXCEPTION 'managed invariant lost'; END IF;
END $test$;
SELECT 'POSTMILL_EDITORIAL_FENCE_SQL_OK';
