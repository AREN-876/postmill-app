\set ON_ERROR_STOP on
-- Full native Prisma schema, disposable PostgreSQL 17 only. Roll back fixture.
BEGIN;
DO $test$
DECLARE s jsonb; task text:='9071'; target text:='max:-73052031470103'; pid text;
 body jsonb; p jsonb; st jsonb; ev jsonb; a jsonb; proof jsonb; claim jsonb; res jsonb; ctx jsonb;
 png bytea:=decode('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNUNPdlYGBgYmBgYGBgAAAHugCprKZFeAAAAABJRU5ErkJggg==','base64');
 digest text; path text:='/uploads/org-modes/2026/11/24/'||repeat('a',32)||'.png';
 fid text; i int; queued jsonb; decision jsonb; next_state jsonb; reply jsonb;
 final_state jsonb; command jsonb; release_result jsonb; pubid text; source_before jsonb;
 action text; bad jsonb;
BEGIN
 INSERT INTO "Organization"(id,name,"updatedAt") VALUES('org-modes','Mock image CI',now());
 INSERT INTO "Integration"(id,"organizationId","internalId",name,"providerIdentifier",type,token)
 VALUES('mock-review-native','org-modes',target,'Mock image CI','max','max','not-a-real-token');
 INSERT INTO "Campaign"(id,"organizationId",name,"updatedAt")
 VALUES('mock-image-campaign','org-modes','Mock image CI',now());
 s:=jsonb_build_object('org_id','org-modes','integration_id','mock-review-native','campaign_id','mock-image-campaign',
  'channel_id','42','profile_ref','review-ci@v3','is_test',true,'image_mode','automatic');
 body:=jsonb_build_object('title','Mock native image CI','parts',jsonb_build_array(repeat('a',2900),repeat('b',2900),repeat('c',2900)));
 p:=jsonb_build_object('schema_version',1,'task_id',task,'scope',s,'content',body,
  'text',jsonb_build_object('revision',1,'sha256',encode(sha256(convert_to(body::text,'UTF8')),'hex')),
  'firstPart',(body->>'title')||E'\n\n'||(body->'parts'->>0),'continuationText',(body->'parts'->>1)||E'\n────────────────────────\n'||(body->'parts'->>2));
 res:=postmill_exchange_create_v1(p,target); pid:=res->'receipt'->'binding'->>'post_id';
 st:=jsonb_build_object('binding',res->'receipt'->'binding','seq','0','image_mode','automatic',
  'text_status','pending','text_request_id',NULL,'text',p->'text','image',NULL,'image_compatible',false,
  'image_intent','initial:1','rejected',false,'final_approved',false,'dispatch_authorized',false,'publishable',false);
 PERFORM postmill_anchor_editorial_review_v1(s,task,target,st);
 digest:=encode(sha256(png),'hex');
 a:=jsonb_build_object('asset_id',gen_random_uuid()::text,'sha256',digest,'mime','image/png','width',2,'height',2,
  'size_bytes',octet_length(png),'provider','mock','model','solid-rgb-v1','job_id',gen_random_uuid()::text);
 ev:=jsonb_build_object('schema_version',1,'event_id','ci-native-image-install','producer','operator','actor_id','ci-owner',
  'occurred_at','2026-11-24T08:00:00Z','binding',st->'binding','expected_seq','0','action','install_image',
  'text',st->'text','image',NULL,'feedback','','request_id','initial:1',
  'revision_content',jsonb_build_object('job_id',a->'job_id','asset_sha256',digest));
 proof:=jsonb_build_object('channel_id','42','install_event_id',ev->>'event_id','install_event',ev,
  'install_payload_sha256',encode(sha256(convert_to(ev::text,'UTF8')),'hex'),'manifest',jsonb_build_array(a),
  'state',st||jsonb_build_object('seq','1','image',jsonb_build_object('revision',1,
   'sha256',encode(sha256(convert_to(jsonb_build_array(a)::text,'UTF8')),'hex')),
   'image_compatible',true,'image_intent',NULL),'publishable',false,'dispatch_authorized',false);
 ASSERT postmill_mock_image_context_v1('org-other',pid,task,target) IS NULL;
 ASSERT postmill_mock_image_context_v1('org-modes',pid,task,'other-target') IS NULL;
 BEGIN
  PERFORM postmill_reserve_mock_image_import_v1('org-modes',pid,task,target,jsonb_set(proof,'{state,text,revision}','2'));
  RAISE EXCEPTION 'tampered image proof accepted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_PROOF_STATE_MISMATCH'; END;
 claim:=postmill_reserve_mock_image_import_v1('org-modes',pid,task,target,proof);
 ASSERT claim->>'status'='reserved';
 ASSERT postmill_editorial_confirmed_v1(pid)->>'status'='image_import_uncertain';
 ASSERT postmill_reserve_mock_image_import_v1('org-modes',pid,task,target,proof)->>'status'='uncertain';
 ASSERT NOT(postmill_reserve_mock_image_import_v1('org-modes',pid,task,target,proof) ? 'token');
 BEGIN
  PERFORM postmill_queue_editorial_human_v1('org-modes',pid,task,target,'ci-editor',
   jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq','0','action','approve_text','feedback',''));
  RAISE EXCEPTION 'decision overtook import';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_IMPORT_UNRESOLVED'; END;
 BEGIN
  PERFORM postmill_finish_mock_image_import_v1('org-modes',pid,task,target,claim->>'import_id',gen_random_uuid()::text,path,digest,octet_length(png));
  RAISE EXCEPTION 'wrong token accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_STORAGE_INVALID'; END;
 BEGIN
  PERFORM postmill_finish_mock_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',path,repeat('0',64),octet_length(png));
  RAISE EXCEPTION 'wrong digest accepted';
 EXCEPTION WHEN invalid_parameter_value THEN ASSERT SQLERRM='EDITORIAL_IMAGE_STORAGE_INVALID'; END;
 ASSERT (SELECT count(*) FROM "File" WHERE "organizationId"='org-modes')=0;
 res:=postmill_finish_mock_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',path,digest,octet_length(png));
 ASSERT res->>'status'='recorded'; fid:=res->>'file_id';
 ASSERT postmill_finish_mock_image_import_v1('org-modes',pid,task,target,claim->>'import_id',claim->>'token',path,digest,octet_length(png))=res;
 ASSERT postmill_reserve_mock_image_import_v1('org-modes',pid,task,target,proof)->>'status'='recorded';
 ASSERT (SELECT count(*) FROM "File" WHERE "organizationId"='org-modes')=1;
 ASSERT (SELECT count(*) FROM "EditorialImageImportReceipt" WHERE "fileId"=fid)=1;
 ASSERT postmill_editorial_confirmed_v1(pid)->'last_confirmed_state'=proof->'state';
 ASSERT postmill_editorial_confirmed_v1(pid)->>'status'='idle';
 ctx:=postmill_mock_image_context_v1('org-modes',pid,task,target);
 ASSERT ctx->'media'->>'file_id'=fid AND ctx->'media'->>'sha256'=digest;
 ASSERT (SELECT image='[]' AND state='DRAFT' AND "approvalStatus"='pending' FROM "Post" WHERE id=pid);
 ASSERT NOT EXISTS(SELECT 1 FROM "EditorialRelease" WHERE "sourcePostId"=pid);
 BEGIN
  DELETE FROM "EditorialImageImportReceipt" WHERE "fileId"=fid;
  RAISE EXCEPTION 'receipt deleted';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_DECISION_LEDGER_IMMUTABLE'; END;
 BEGIN
  UPDATE "File" SET path='tampered' WHERE id=fid;
  RAISE EXCEPTION 'media modified';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_FILE_IMMUTABLE'; END;
 BEGIN
  DELETE FROM "File" WHERE id=fid;
  RAISE EXCEPTION 'media removed';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_IMAGE_FILE_IMMUTABLE'; END;
 BEGIN
  UPDATE "Post" SET image='[{"path":"tampered"}]' WHERE id=pid;
  RAISE EXCEPTION 'native draft image bypass';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_MANAGED_DRAFT_FROZEN'; END;

 -- No release before both approved revisions and an accepted approve_final.
 command:=jsonb_build_object('command_id',gen_random_uuid()::text,'action','publish_now','publish_at',NULL);
 BEGIN
  PERFORM postmill_qualify_mock_image_release_v1('org-modes',pid,task,target,'ci-editor',command,proof->'state',png);
  RAISE EXCEPTION 'unapproved mock release';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_RELEASE_NOT_APPROVED'; END;
 next_state:=proof->'state';
 FOREACH action IN ARRAY ARRAY['approve_text','approve_final'] LOOP
  queued:=postmill_queue_editorial_human_v1('org-modes',pid,task,target,'ci-editor',
   jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq',next_state->>'seq','action',action,'feedback',''));
  decision:=postmill_read_editorial_delivery_v1(s,task,target);
  ASSERT decision->>'event_id'=queued->>'event_id';
  PERFORM postmill_reserve_editorial_delivery_v1(s,task,target,decision->>'event_id');
  IF action='approve_text' THEN
   next_state:=next_state||'{"seq":"2","text_status":"approved"}'::jsonb;
  ELSE
   next_state:=next_state||'{"seq":"3","final_approved":true}'::jsonb;
  END IF;
  reply:=jsonb_build_object('status','accepted','reason',NULL,'state',next_state,'dispatch_authorized',false,
   'publishable',false,'newly_applied',true,'replay',false);
  ASSERT postmill_import_editorial_result_v1(s,task,target,decision->>'event_id',decision->>'payload_sha256',reply)->>'newly_recorded'='true';
 END LOOP;
 final_state:=postmill_editorial_confirmed_v1(pid)->'last_confirmed_state';
 ASSERT final_state=next_state;
 -- The normal production release SQL remains disabled-only.
 BEGIN
  PERFORM postmill_release_editorial_story_v1('org-modes',pid,task,target,'ci-editor',command);
  RAISE EXCEPTION 'production image release opened';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_RELEASE_NOT_APPROVED'; END;
 FOREACH bad IN ARRAY ARRAY[jsonb_set(final_state,'{seq}','"2"'),jsonb_set(final_state,'{image,sha256}',to_jsonb(repeat('f',64))),jsonb_set(final_state,'{image_compatible}','false')] LOOP
  BEGIN
   PERFORM postmill_qualify_mock_image_release_v1('org-modes',pid,task,target,'ci-editor',command,bad,png);
   RAISE EXCEPTION 'wrong approved pair released';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_MOCK_RELEASE_IMAGE_MISMATCH'; END;
 END LOOP;
 BEGIN
  PERFORM postmill_qualify_mock_image_release_v1('org-modes',pid,task,target,'ci-editor',command,final_state,decode('ffd8ffd9','hex'));
  RAISE EXCEPTION 'wrong native bytes released';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_MOCK_RELEASE_IMAGE_MISMATCH'; END;
 SELECT to_jsonb(native_source) INTO source_before FROM "Post" native_source WHERE native_source.id=pid;
 release_result:=postmill_qualify_mock_image_release_v1('org-modes',pid,task,target,'ci-editor',command,final_state,png);
 pubid:=release_result->>'publication_post_id';
 ASSERT release_result->>'status'='isolated_native_queue_fixture' AND release_result->>'created'='true';
 ASSERT release_result->'dispatch_authorized'='false'::jsonb AND release_result->'publishable'='false'::jsonb;
 ASSERT pubid<>pid;
 ASSERT (SELECT to_jsonb(native_source) FROM "Post" native_source WHERE native_source.id=pid)=source_before;
 ASSERT (SELECT state='QUEUE' AND "approvalStatus"='approved' AND "editorialTaskId" IS NULL AND image='[]'
  AND content=source_before->>'content'
  AND settings::jsonb=(source_before->>'settings')::jsonb||jsonb_build_object('storyImageId',fid,'storyImageSha256',digest)
  FROM "Post" WHERE id=pubid);
 ASSERT postmill_qualify_mock_image_release_v1('org-modes',pid,task,target,'ci-editor',command,final_state,png)->>'created'='false';
 ASSERT (SELECT count(*) FROM "EditorialRelease" WHERE "sourcePostId"=pid)=1;
 BEGIN
  PERFORM postmill_qualify_mock_image_release_v1('org-modes',pid,task,target,'ci-editor',jsonb_set(command,'{command_id}',to_jsonb(gen_random_uuid()::text)),final_state,png);
  RAISE EXCEPTION 'second release created';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_RELEASE_ALREADY_EXISTS'; END;
 BEGIN
  UPDATE "Post" SET settings=jsonb_set(settings::jsonb,'{storyImageSha256}',to_jsonb(repeat('0',64)))::text WHERE id=pubid;
  RAISE EXCEPTION 'release photo digest mutable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_PUBLICATION_IMMUTABLE'; END;
 BEGIN
  DELETE FROM "Post" WHERE id=pubid;
  RAISE EXCEPTION 'release clone deletable';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN ASSERT SQLERRM='EDITORIAL_PUBLICATION_IMMUTABLE'; END;

END $test$;
ROLLBACK;
SELECT 'POSTMILL_NATIVE_MOCK_IMAGE_RECEIPT_FULL_SCHEMA_OK';
SELECT 'POSTMILL_MOCK_IMAGE_RELEASE_FULL_SCHEMA_OK';
