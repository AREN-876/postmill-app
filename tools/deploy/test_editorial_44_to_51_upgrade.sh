#!/usr/bin/env bash
# CI ONLY: actual historic 44 Prisma migrations -> pg_dump/pg_restore -> 56.
set -Eeuo pipefail
OLD=9f867ba77472b8574d60407112e2caebf5304eb4
REL=libraries/nestjs-libraries/src/database/prisma
DB_OLD=edx_upgrade_source_44
DB_NEW=edx_upgrade_restored_44
PGUSER=postmill-local

if [[ "${GITHUB_ACTIONS:-}" != 'true' || "${EDX_44_51_CI:-}" != '1' ||
      ! "${PG_CI_CONTAINER:-}" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'REFUSED: no isolated, explicitly authorized GitHub Actions database' >&2
  exit 2
fi
C="$PG_CI_CONTAINER"
[[ "$(docker inspect "$C" --format '{{.Config.Image}}')" == 'postgres:17-alpine' ]]
[[ "$(docker exec "$C" psql -X -w -U "$PGUSER" -Atq -d postmill-db-local -c 'SELECT current_database()')" == 'postmill-db-local' ]]
for db in "$DB_OLD" "$DB_NEW"; do
  [[ "$(docker exec "$C" psql -X -w -U "$PGUSER" -Atq -d postgres -c "SELECT count(*) FROM pg_database WHERE datname='$db'")" == '0' ]]
done
sql() {
  docker exec -i "$C" psql -X -w -U "$PGUSER" -v ON_ERROR_STOP=1 -Atq -d "$1"
}
git cat-file -e "$OLD^{commit}"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
git archive "$OLD" "$REL/schema.prisma" "$REL/migrations" | tar -xf - -C "$ROOT"
OLD_SCHEMA="$ROOT/$REL/schema.prisma"
NEW_SCHEMA="$GITHUB_WORKSPACE/$REL/schema.prisma"
[[ -f "$OLD_SCHEMA" && -f "$NEW_SCHEMA" ]]
[[ "$(find "$ROOT/$REL/migrations" -name migration.sql | wc -l)" == '44' ]]
[[ "$(find "$GITHUB_WORKSPACE/$REL/migrations" -name migration.sql | wc -l)" == '56' ]]
[[ -f "$ROOT/$REL/migrations/20261114090000_max_target_binding/migration.sql" ]]
[[ ! -d "$ROOT/$REL/migrations/20261119120000_editorial_draft_fence" ]]
[[ -f "$GITHUB_WORKSPACE/$REL/migrations/20261120130000_editorial_human_review/migration.sql" ]]

# Only isolated disposable DBs are created. Both migration sets are real.
docker exec "$C" createdb -U "$PGUSER" "$DB_OLD"
export DATABASE_URL="postgresql://postmill-local:postmill-local-pwd@127.0.0.1:5432/$DB_OLD"
npx --yes prisma@6.5.0 migrate deploy --schema "$OLD_SCHEMA"
[[ "$(sql "$DB_OLD" <<'SQL'
SELECT count(*) FILTER(WHERE finished_at IS NOT NULL)::text||'|'||
       count(*) FILTER(WHERE finished_at IS NULL AND rolled_back_at IS NULL)::text
FROM "_prisma_migrations";
SQL
)" == '44|0' ]]
[[ "$(sql "$DB_OLD" <<'SQL'
SELECT migration_name FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 1;
SQL
)" == '20261114090000_max_target_binding' ]]

# Representative pre-existing ordinary records, not a simulated managed draft.
sql "$DB_OLD" <<'SQL'
INSERT INTO "Organization"(id,name,"updatedAt")
 VALUES('edx-ci-org-44','Temporary migration source',now());
INSERT INTO "Integration"(id,"organizationId","internalId",name,
  "providerIdentifier",type,token)
 VALUES('edx-ci-max-44','edx-ci-org-44','edx-ci-target-44',
        'Offline fake MAX','max','max','NO_REAL_MAX_TOKEN');
INSERT INTO "Campaign"(id,"organizationId",name,"updatedAt")
 VALUES('edx-ci-campaign-44','edx-ci-org-44','Offline campaign',now());
INSERT INTO "Post"(id,"organizationId","integrationId","group","state",
  "publishDate",content,"campaignId","approvalStatus","updatedAt")
 VALUES('edx-ci-original-post-44','edx-ci-org-44','edx-ci-max-44',
        'edx-ci-ordinary-group','DRAFT',now(),'Preserve this 44-migration draft',
        'edx-ci-campaign-44','pending',now());
SQL
[[ "$(sql "$DB_OLD" <<'SQL'
SELECT count(*) FROM "Post" WHERE id='edx-ci-original-post-44' AND state='DRAFT';
SQL
)" == '1' ]]

# PostgreSQL 17 logical backup, REAL restore, row + migration verification.
docker exec "$C" pg_dump -U "$PGUSER" -Fc --no-owner --no-acl \
  -f /tmp/edx-44-ci.dump "$DB_OLD"
docker exec "$C" pg_restore --list /tmp/edx-44-ci.dump >/dev/null
docker exec "$C" createdb -U "$PGUSER" "$DB_NEW"
docker exec "$C" pg_restore -U "$PGUSER" --exit-on-error \
  --no-owner --no-acl -d "$DB_NEW" /tmp/edx-44-ci.dump
[[ "$(sql "$DB_NEW" <<'SQL'
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
SQL
)" == '44' ]]
[[ "$(sql "$DB_NEW" <<'SQL'
SELECT count(*) FROM "Post"
WHERE id='edx-ci-original-post-44'
 AND state='DRAFT' AND content='Preserve this 44-migration draft';
SQL
)" == '1' ]]

# Strict upgrade, WITHOUT db push, auto-baseline or reset.
export DATABASE_URL="postgresql://postmill-local:postmill-local-pwd@127.0.0.1:5432/$DB_NEW"
npx --yes prisma@6.5.0 migrate deploy --schema "$NEW_SCHEMA"
sql "$DB_NEW" <<'SQL'
DO $ci$
DECLARE want text[]:=ARRAY[
 '20261119120000_editorial_draft_fence',
 '20261119130000_editorial_draft_receipt',
 '20261119140000_editorial_exchange_target',
 '20261119150000_editorial_decision_outbox',
 '20261119160000_editorial_decision_result',
 '20261120120000_editorial_delivery_read',
 '20261120130000_editorial_human_review',
 '20261121120000_editorial_release_command',
 '20261122190000_editorial_delivery_reservation',
 '20261123150000_editorial_pre_review_text_install',
 '20261124100000_editorial_delivery_recovery',
 '20261124120000_editorial_text_revision'
];
body jsonb; scope jsonb; prepared jsonb; one jsonb; two jsonb; seen jsonb;
pid text; digest text;
BEGIN
 IF (SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL)<>56
 OR EXISTS(SELECT 1 FROM "_prisma_migrations"
           WHERE finished_at IS NULL AND rolled_back_at IS NULL)
 OR (SELECT count(*) FROM "_prisma_migrations" WHERE migration_name=ANY(want)
      AND finished_at IS NOT NULL)<>12
 OR to_regclass('public."EditorialDraftReceipt"') IS NULL
 OR to_regclass('public."EditorialDecisionResult"') IS NULL
 OR to_regclass('public."EditorialRelease"') IS NULL
 OR to_regclass('public."EditorialDeliveryReservation"') IS NULL
 OR to_regclass('public."EditorialDeliveryRecovery"') IS NULL
 OR to_regclass('public."EditorialTextRevision"') IS NULL
 OR to_regprocedure('postmill_import_editorial_revision_v1(jsonb,text,text,text,text,jsonb)') IS NULL
 OR to_regprocedure('postmill_reserve_editorial_recovery_v1(jsonb,text,text,text,text)') IS NULL
 OR to_regprocedure('postmill_reserve_editorial_delivery_v1(jsonb,text,text,text)') IS NULL
 OR to_regprocedure('postmill_release_editorial_story_v1(text,text,text,text,text,jsonb)') IS NULL
 OR to_regprocedure('postmill_exchange_create_v1(jsonb,text)') IS NULL
 OR (SELECT count(*) FROM "Post" WHERE id='edx-ci-original-post-44'
    AND state='DRAFT' AND content='Preserve this 44-migration draft'
    AND "editorialTaskId" IS NULL)<>1
 THEN RAISE EXCEPTION 'EDX_44_TO_56_MIGRATION_FAILED'; END IF;

 body:=jsonb_build_object('title','Synthetic upgraded draft',
   'parts',jsonb_build_array(repeat('a',2900),repeat('b',2900),repeat('c',2900)));
 scope:=jsonb_build_object('org_id','edx-ci-org-44',
   'integration_id','edx-ci-max-44','campaign_id','edx-ci-campaign-44',
   'channel_id','42','profile_ref','life-stories-terra-test@v1',
   'is_test',true,'image_mode','disabled');
 digest:=encode(sha256(convert_to(body::text,'UTF8')),'hex');
 prepared:=jsonb_build_object(
   'schema_version',1,'task_id','804','scope',scope,'content',body,
   'text',jsonb_build_object('revision',1,'sha256',digest),
   'firstPart',(body->>'title')||E'\n\n'||(body->'parts'->>0),
   'continuationText',(body->'parts'->>1)||E'\n'||
     '────────────────────────'||E'\n'||(body->'parts'->>2));
 one:=postmill_exchange_create_v1(prepared,'edx-ci-target-44');
 two:=postmill_exchange_create_v1(prepared,'edx-ci-target-44');
 seen:=postmill_read_editorial_draft_v1(scope,'804','edx-ci-target-44');
 pid:=one->'receipt'->'binding'->>'post_id';
 IF one->'created' IS DISTINCT FROM 'true'::jsonb
 OR two->'created' IS DISTINCT FROM 'false'::jsonb
 OR one->'receipt' IS DISTINCT FROM two->'receipt'
 OR seen->'receipt' IS DISTINCT FROM one->'receipt'
 OR seen->'native_verified' IS DISTINCT FROM 'true'::jsonb
 OR one->'receipt'->'text'->>'sha256' IS DISTINCT FROM digest
 OR one->'receipt'->'publishable' IS DISTINCT FROM 'false'::jsonb
 OR one->'receipt'->'dispatch_authorized' IS DISTINCT FROM 'false'::jsonb
 OR (SELECT count(*) FROM "EditorialDraftReceipt")<>1
 OR (SELECT count(*) FROM "Post" WHERE "organizationId"='edx-ci-org-44')<>2
 OR NOT EXISTS(SELECT 1 FROM "Post" WHERE id=pid AND state='DRAFT'
               AND "approvalStatus"='pending')
 THEN RAISE EXCEPTION 'EDX_44_TO_56_DRAFT_UNSAFE'; END IF;
 BEGIN
   UPDATE "Post" SET state='QUEUE' WHERE id=pid;
   RAISE EXCEPTION 'EDX_MANAGED_DRAFT_PUBLISH_ALLOWED';
 EXCEPTION WHEN object_not_in_prerequisite_state THEN
   IF SQLERRM<>'EDITORIAL_MANAGED_DRAFT_FROZEN' THEN RAISE; END IF;
 END;
END $ci$;
SELECT 'EDX_REAL_44_BACKUP_RESTORE_56_SQL_OK';
SQL
# Full Prisma schema drift on an actual upgraded, non-empty database.
npx --yes prisma@6.5.0 migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel "$NEW_SCHEMA" --exit-code
echo 'POSTMILL_44_TO_56_ISOLATED_DRILL_OK'
