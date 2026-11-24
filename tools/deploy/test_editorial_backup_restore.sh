#!/usr/bin/env bash
# Editorial 07/09B: CI-only full-schema PostgreSQL 17 dump/restore drill.
# Only the disposable PostgreSQL GitHub Actions service container is targeted.
set -Eeuo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${EDX_BACKUP_CI:-}" != "1" ||
      ! "${PG_CI_CONTAINER:-}" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'REFUSED: requires isolated, explicit GitHub Actions PG17 service' >&2
  exit 2
fi
C="$PG_CI_CONTAINER"
if [[ "$(docker inspect "$C" --format '{{.Config.Image}}')" != 'postgres:17-alpine' ]]; then
  echo 'REFUSED: unexpected PostgreSQL service image' >&2
  exit 2
fi
SOURCE=postmill-db-local
RESTORE=postmill-editorial-restore-ci
DBUSER=postmill-local
BACKUP=/tmp/editorial-ci-full-prisma.dump

sql() {
  docker exec -i "$C" psql -X -w -U "$DBUSER" \
    -v ON_ERROR_STOP=1 -Atq -d "$1"
}
[[ "$(sql "$SOURCE" <<'SQL'
SELECT current_database();
SQL
)" == "$SOURCE" ]]
[[ "$(sql "$SOURCE" <<'SQL'
SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
SQL
)" == '57' ]] || {
  echo 'FAIL: source must contain all 57 reviewed migrations before backup' >&2
  exit 1
}
[[ "$(sql "$SOURCE" <<'SQL'
SELECT COUNT(*) FROM "EditorialDraftReceipt";
SQL
)" == '3' ]] || {
  echo 'FAIL: isolated integration test must leave three managed editorial drafts' >&2
  exit 1
}
[[ "$(sql "$SOURCE" <<'SQL'
SELECT COUNT(*) FROM "EditorialRelease";
SQL
)" == '2' ]] || {
  echo 'FAIL: isolated integration test must leave two one-post story releases' >&2
  exit 1
}
[[ "$(sql postgres <<'SQL'
SELECT count(*) FROM pg_database WHERE datname='postmill-editorial-restore-ci';
SQL
)" == '0' ]] || {
  echo 'REFUSED: restore target already exists' >&2; exit 2;
}

# Dump and restore using the PG17 server image, not the runner's client tools.
docker exec "$C" pg_dump -U "$DBUSER" -Fc --no-owner --no-acl \
  -f "$BACKUP" "$SOURCE"
docker exec "$C" pg_restore --list "$BACKUP" >/dev/null
docker exec "$C" createdb -U "$DBUSER" "$RESTORE"
docker exec "$C" pg_restore -U "$DBUSER" --exit-on-error \
  --no-owner --no-acl -d "$RESTORE" "$BACKUP"

sql "$RESTORE" <<'SQL'
DO $ci$
DECLARE migrations integer; draft_count integer; release_count integer;
  install_count integer; invalid integer; invalid_releases integer;
  invalid_installs integer;
BEGIN
  SELECT count(*) INTO migrations FROM "_prisma_migrations"
   WHERE finished_at IS NOT NULL;
  SELECT count(*) INTO draft_count FROM "EditorialDraftReceipt";
  SELECT count(*) INTO release_count FROM "EditorialRelease";
  SELECT count(*) INTO install_count FROM "EditorialTextInstall";
  SELECT count(*) INTO invalid_releases FROM "EditorialRelease" r
   JOIN "Post" source ON source.id=r."sourcePostId"
   JOIN "Post" publication ON publication.id=r."publicationPostId"
   WHERE source.state<>'DRAFT' OR publication.state<>'QUEUE'
      OR publication."editorialTaskId" IS NOT NULL
      OR source."integrationId" IS DISTINCT FROM publication."integrationId"
      OR source.content IS DISTINCT FROM publication.content
      OR source.settings IS DISTINCT FROM publication.settings;
  SELECT count(*) INTO invalid_installs FROM "EditorialTextInstall" i
   JOIN "EditorialDraftReceipt" r ON r."postId"=i."postId"
   JOIN "Post" p ON p.id=i."postId"
   WHERE p.state<>'DRAFT' OR i."sourceHash" IS DISTINCT FROM r.request->'text'->>'sha256'
     OR p.content IS DISTINCT FROM i.request->>'firstPart'
     OR p.settings::jsonb->>'continuationText' IS DISTINCT FROM i.request->>'continuationText'
     OR i.request->'text'->>'sha256' IS DISTINCT FROM
        encode(sha256(convert_to((i.request->'content')::text,'UTF8')),'hex');
  SELECT count(*) INTO invalid FROM "Post" p
   JOIN "EditorialDraftReceipt" r ON r."postId"=p.id
   WHERE p.state<>'DRAFT' OR p."approvalStatus"<>'pending'
      OR p."editorialTaskId" IS NULL OR p."group"<>'editorial-v1-'||p.id;
  IF migrations<>57 OR draft_count<>3 OR release_count<>2 OR install_count<>1
    OR invalid<>0 OR invalid_releases<>0 OR invalid_installs<>0
    OR to_regclass('public."EditorialDecisionOutbox"') IS NULL
    OR to_regclass('public."EditorialDecisionResult"') IS NULL
    OR to_regclass('public."EditorialRelease"') IS NULL
    OR to_regclass('public."EditorialDeliveryReservation"') IS NULL
    OR to_regclass('public."EditorialDeliveryRecovery"') IS NULL
    OR to_regclass('public."EditorialTextRevision"') IS NULL
    OR to_regclass('public."EditorialImageImportReceipt"') IS NULL
    OR to_regclass('public."EditorialTextInstall"') IS NULL
    OR to_regprocedure('postmill_reserve_editorial_delivery_v1(jsonb,text,text,text)') IS NULL
    OR to_regprocedure('postmill_release_editorial_story_v1(text,text,text,text,text,jsonb)') IS NULL
    OR to_regprocedure('postmill_read_editorial_delivery_v1(jsonb,text,text)') IS NULL
  THEN
    RAISE EXCEPTION 'EDITORIAL_CI_RESTORE_CONTRACT_FAILED';
  END IF;
END $ci$;
SQL
sql "$RESTORE" < tools/db/editorial-revision-full-assertions.sql
sql "$RESTORE" < tools/db/editorial-image-full-assertions.sql
echo 'POSTMILL_FULL_PRISMA_BACKUP_AND_RESTORE_CI_OK'
