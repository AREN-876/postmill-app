\set ON_ERROR_STOP on
DO $$
DECLARE p jsonb:=pg_temp.prepared_draft('150'); s jsonb:=p->'scope';
 a jsonb; b jsonb; id1 text; n bigint;
BEGIN
 a:=postmill_exchange_create_v1(p,'test-channel');
 b:=postmill_read_editorial_draft_v1(s,'150','test-channel');
 IF a->'created' IS DISTINCT FROM 'true'::jsonb OR a-'created' IS DISTINCT FROM b
 OR b->'native_verified' IS DISTINCT FROM 'true'::jsonb OR b->'review_acknowledged' IS DISTINCT FROM 'false'::jsonb
 OR b->'receipt'->'publishable' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'invalid create/read contract'; END IF;
 IF postmill_exchange_create_v1(p,'test-channel')->'created' IS DISTINCT FROM 'false'::jsonb THEN
  RAISE EXCEPTION 'duplicate created'; END IF;
 id1:=a->'receipt'->'binding'->>'post_id';
 IF (SELECT "targetSnapshot" FROM "EditorialDraftReceipt" WHERE "postId"=id1) IS NULL THEN
  RAISE EXCEPTION 'missing immutable target'; END IF;
 IF postmill_read_editorial_draft_v1(jsonb_set(s,'{org_id}','"org-b"'),'150','test-channel') IS NOT NULL
 OR postmill_read_editorial_draft_v1(jsonb_set(s,'{profile_ref}','"other@v1"'),'150','test-channel') IS NOT NULL
 OR postmill_read_editorial_draft_v1(s,'151','test-channel') IS NOT NULL THEN
  RAISE EXCEPTION 'scope leak'; END IF;
 SELECT count(*) INTO n FROM "Post";
 BEGIN PERFORM postmill_exchange_create_v1(pg_temp.prepared_draft('151'),'wrong-channel');
  RAISE EXCEPTION 'wrong physical target accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_UNAVAILABLE' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_exchange_create_v1(pg_temp.prepared_draft('15'),'test-channel');
  RAISE EXCEPTION 'legacy unpinned receipt adopted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_CHANGED' THEN RAISE; END IF; END;
 UPDATE "Integration" SET "internalId"='other-channel' WHERE id='max-a';
 BEGIN PERFORM postmill_read_editorial_draft_v1(s,'150','test-channel');
  RAISE EXCEPTION 'rebound target accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_UNAVAILABLE' THEN RAISE; END IF; END;
 BEGIN PERFORM postmill_exchange_create_v1(p,'other-channel');
  RAISE EXCEPTION 'changed target adopted on retry';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_CHANGED' THEN RAISE; END IF; END;
 UPDATE "Integration" SET "internalId"='test-channel', token='changed-encrypted-token' WHERE id='max-a';
 BEGIN PERFORM postmill_read_editorial_draft_v1(s,'150','test-channel');
  RAISE EXCEPTION 'token identity change accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_TARGET_CHANGED' THEN RAISE; END IF; END;
 UPDATE "Integration" SET token='synthetic-encrypted-token' WHERE id='max-a';
 INSERT INTO "Post"(id,"organizationId","integrationId","group","parentPostId")
  VALUES('native-child','org-a','max-a','ordinary-child',id1);
 BEGIN PERFORM postmill_read_editorial_draft_v1(s,'150','test-channel');
  RAISE EXCEPTION 'unexpected child accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM<>'EDITORIAL_DRAFT_MISMATCH' THEN RAISE; END IF; END;
 DELETE FROM "Post" WHERE id='native-child';
 IF (SELECT count(*) FROM "Post")<>n THEN RAISE EXCEPTION 'unexpected write'; END IF;
 IF postmill_read_editorial_draft_v1(s,'150','test-channel') IS DISTINCT FROM b THEN
  RAISE EXCEPTION 'reconciliation changed'; END IF;
END $$;
SELECT 'POSTMILL_EDITORIAL_TARGET_RECEIPT_OK';
