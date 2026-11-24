\set ON_ERROR_STOP on
-- Run only against the already isolated, restored full Prisma CI database.
-- No external provider; roll back synthetic draft, revision and release.
BEGIN;
DO $revision$
DECLARE s jsonb; task text:='9061'; target text:='max:-73052031470103';
 pid text; body jsonb; initial_content jsonb; p jsonb; st jsonb; prior jsonb;
 queued jsonb; event "EditorialDecisionOutbox"%ROWTYPE; req text;
 op jsonb; proof jsonb; res jsonb; newer jsonb; n integer;
 iid text:='revision-ci-'||replace(gen_random_uuid()::text,'-','');
 cmd jsonb; published text;
BEGIN
 SELECT request->'scope' INTO STRICT s FROM "EditorialDraftReceipt" LIMIT 1;
 s:=s||jsonb_build_object('integration_id',iid,'image_mode','disabled');
 INSERT INTO "Integration"(id,"organizationId","internalId",name,"providerIdentifier",type,token)
 VALUES(iid,s->>'org_id',target,'Isolated revision CI','max','max','synthetic-not-usable');
 initial_content:=jsonb_build_object('title','Initial revision CI',
   'parts',jsonb_build_array(repeat('a',2900),repeat('b',2900),repeat('c',2900)));
 p:=jsonb_build_object('schema_version',1,'task_id',task,'scope',s,
   'text',jsonb_build_object('revision',1,'sha256',encode(sha256(convert_to(initial_content::text,'UTF8')),'hex')),
   'content',initial_content,'firstPart',(initial_content->>'title')||E'\n\n'||(initial_content->'parts'->>0),
   'continuationText',(initial_content->'parts'->>1)||E'\n────────────────────────\n'||(initial_content->'parts'->>2));
 res:=postmill_exchange_create_v1(p,target); pid:=res->'receipt'->'binding'->>'post_id';
 st:=jsonb_build_object('binding',res->'receipt'->'binding','seq','0','image_mode','disabled',
   'text_status','pending','text_request_id',NULL,'text',p->'text','image',NULL,
   'image_compatible',false,'image_intent',NULL,'rejected',false,'final_approved',false,
   'dispatch_authorized',false,'publishable',false);
 PERFORM postmill_anchor_editorial_review_v1(s,task,target,st);

 FOR n IN 2..3 LOOP
  queued:=postmill_queue_editorial_human_v1(s->>'org_id',pid,task,target,'fixture-editor',
   jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq',st->>'seq',
   'action','request_text_changes','feedback','Update revision '||n));
  req:=queued->>'event_id';
  SELECT * INTO STRICT event FROM "EditorialDecisionOutbox" WHERE "eventId"=req;
  prior:=postmill_editorial_next_state_v1(st,event.payload);
  PERFORM postmill_import_editorial_result_v1(s,task,target,req,event."payloadHash",
   jsonb_build_object('status','accepted','reason',NULL,'state',prior,'dispatch_authorized',false,
   'publishable',false,'newly_applied',true,'replay',false));
  IF prior->>'text_status'<>'changes_requested' THEN RAISE EXCEPTION 'return not accepted'; END IF;
  BEGIN
   PERFORM postmill_queue_editorial_human_v1(s->>'org_id',pid,task,target,'fixture-editor',
    jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq',prior->>'seq','action','reject','feedback',''));
   RAISE EXCEPTION 'human decision overtook revision';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'EDITORIAL_REVISION_AWAITING_IMPORT' THEN RAISE; END IF;
  END;
  BEGIN
   UPDATE "Post" SET content='unverified' WHERE id=pid;
   RAISE EXCEPTION 'native edit allowed';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'EDITORIAL_MANAGED_DRAFT_FROZEN' THEN RAISE; END IF;
  END;
  body:=jsonb_build_object('title','Revised CI '||n,'parts',
   jsonb_build_array(repeat('a',2900),repeat('b',2900),repeat('c',2900)));
  op:=jsonb_build_object('schema_version',1,'event_id',gen_random_uuid()::text,
   'producer','operator','actor_id','fixture-owner','occurred_at','2026-11-24T08:00:00Z',
   'binding',prior->'binding','expected_seq',prior->>'seq','action','install_text',
   'text',prior->'text','image',prior->'image','feedback','','request_id',req,'revision_content',body);
  newer:=prior||jsonb_build_object('seq',((prior->>'seq')::bigint+1)::text,
   'text',jsonb_build_object('revision',n,'sha256',encode(sha256(convert_to(body::text,'UTF8')),'hex')),
   'text_status','pending','text_request_id',NULL,'final_approved',false,'image_intent',NULL,'image_compatible',false);
  proof:=jsonb_build_object('install_event_id',op->>'event_id',
   'install_payload_sha256',encode(sha256(convert_to(op::text,'UTF8')),'hex'),
   'install_event',op,'state',newer,'publishable',false,'dispatch_authorized',false);
  BEGIN
   PERFORM postmill_import_editorial_revision_v1(s,task,target,req,event."payloadHash",
      jsonb_set(proof,'{state,final_approved}','true'::jsonb));
   RAISE EXCEPTION 'forged approval accepted';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'EDITORIAL_REVISION_STATE_MISMATCH' THEN RAISE; END IF;
  END;
  res:=postmill_import_editorial_revision_v1(s,task,target,req,event."payloadHash",proof);
  IF res->'installed' IS DISTINCT FROM 'true'::jsonb OR res->'state' IS DISTINCT FROM newer
   OR postmill_import_editorial_revision_v1(s,task,target,req,event."payloadHash",proof)->'installed'
       IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'revision import/replay mismatch'; END IF;
  res:=postmill_read_editorial_human_v1(s->>'org_id',pid,task,target);
  IF res->'content' IS DISTINCT FROM body OR res->'review'->'last_confirmed_state' IS DISTINCT FROM newer
    OR res->'receipt'->'text' IS DISTINCT FROM newer->'text'
    OR (SELECT count(*) FROM "EditorialTextRevision" WHERE "postId"=pid)<>n-1
    OR postmill_editorial_artifact_v1(pid,1)->'content' IS DISTINCT FROM initial_content
    OR NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT'
       AND "approvalStatus"='pending' AND content=(body->>'title')||E'\n\n'||(body->'parts'->>0))
  THEN RAISE EXCEPTION 'revision history/native read mismatch'; END IF;
  BEGIN
   UPDATE "EditorialTextRevision" SET proof=proof WHERE "requestEventId"=req;
   RAISE EXCEPTION 'mutable revision history';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'EDITORIAL_DECISION_LEDGER_IMMUTABLE' THEN RAISE; END IF;
  END;
  st:=newer;
 END LOOP;
 cmd:=jsonb_build_object('command_id',gen_random_uuid()::text,'action','publish_now','publish_at',NULL);
 BEGIN
  PERFORM postmill_release_editorial_story_v1(s->>'org_id',pid,task,target,'fixture-editor',cmd);
  RAISE EXCEPTION 'unapproved revision released';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
  IF SQLERRM<>'EDITORIAL_RELEASE_NOT_APPROVED' THEN RAISE; END IF;
 END;
 queued:=postmill_queue_editorial_human_v1(s->>'org_id',pid,task,target,'fixture-editor',
   jsonb_build_object('command_id',gen_random_uuid()::text,'expected_seq',st->>'seq','action','approve_text','feedback',''));
 SELECT * INTO STRICT event FROM "EditorialDecisionOutbox" WHERE "eventId"=queued->>'event_id';
 newer:=postmill_editorial_next_state_v1(st,event.payload);
 PERFORM postmill_import_editorial_result_v1(s,task,target,event."eventId",event."payloadHash",
  jsonb_build_object('status','accepted','reason',NULL,'state',newer,'dispatch_authorized',false,
   'publishable',false,'newly_applied',true,'replay',false));
 IF newer->>'seq'<>'5' OR newer->'final_approved' IS DISTINCT FROM 'true'::jsonb
   OR newer->'text'->'revision' IS DISTINCT FROM '3'::jsonb
 THEN RAISE EXCEPTION 'wrong final revision or seq'; END IF;
 res:=postmill_release_editorial_story_v1(s->>'org_id',pid,task,target,'fixture-editor',cmd);
 published:=res->>'publication_post_id';
 IF NOT EXISTS(SELECT 1 FROM "Post" a JOIN "Post" b ON b.id=published
   WHERE a.id=pid AND a.state='DRAFT' AND b.state='QUEUE'
    AND b.content=a.content AND b.settings=a.settings)
 THEN RAISE EXCEPTION 'release copied stale revision'; END IF;
END $revision$;
ROLLBACK;
SELECT 'POSTMILL_EDITORIAL_VERSIONED_TEXT_FULL_DB_OK';
