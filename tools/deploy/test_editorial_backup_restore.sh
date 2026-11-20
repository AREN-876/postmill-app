#!/usr/bin/env bash
# Editorial 07 — DRILL ONLY. Discarded GitHub Actions PostgreSQL service.
# No VPS, no live credentials, no Docker volumes, no external network.
set -Eeuo pipefail
if [[ "${GITHUB_ACTIONS:-}" != "true" || "${EDX_BACKUP_CI:-}" != "1" ]]; then
  echo 'REFUSED: this PostgreSQL restore drill runs only in explicit isolated CI' >&2
  exit 2
fi

# Never trust caller-supplied connection environment in this CI-only script.
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postmill-local PGPASSWORD=postmill-local-pwd
export PGSSLMODE=disable PGCONNECT_TIMEOUT=4
SOURCE=postmill-db-local
RESTORE=postmill-editorial-restore-ci
BACKUP=$(mktemp)
trap 'rm -f "$BACKUP"' EXIT

# Fail before a local CREATE DATABASE if the fixed source is unexpected.
[[ "$(psql -X -w -v ON_ERROR_STOP=1 -Atq -d "$SOURCE" -c 'SELECT current_database()')" == "$SOURCE" ]]
[[ "$(psql -X -w -v ON_ERROR_STOP=1 -Atq -d "$SOURCE" -c   'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')" == "51" ]]
[[ "$(psql -X -w -v ON_ERROR_STOP=1 -Atq -d "$SOURCE" -c   'SELECT COUNT(*) FROM "EditorialDraftReceipt"')" == "1" ]]

pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP" --dbname="$SOURCE"
[[ -s "$BACKUP" ]]
pg_restore --list "$BACKUP" >/dev/null

# Never drop an existing database, even one with the expected test name.
if psql -X -w -v ON_ERROR_STOP=1 -Atq -d postgres -c     "SELECT 1 FROM pg_database WHERE datname='$RESTORE'" | grep -q '1'; then
  echo 'REFUSED: restore target exists' >&2
  exit 2
fi
createdb "$RESTORE"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$RESTORE" "$BACKUP"

# Check actual restored SQL structures AND persistent synthetic DRAFT ledger.
psql -X -w -v ON_ERROR_STOP=1 -Atq -d "$RESTORE" <<'SQL'
DO $ci$
DECLARE migrations integer; draft_count integer; invalid integer;
BEGIN
  SELECT count(*) INTO migrations FROM "_prisma_migrations"
   WHERE finished_at IS NOT NULL;
  SELECT count(*) INTO draft_count FROM "EditorialDraftReceipt";
  SELECT count(*) INTO invalid FROM "Post" p
   JOIN "EditorialDraftReceipt" r ON r."postId"=p.id
   WHERE p.state<>'DRAFT' OR p."approvalStatus"<>'pending'
      OR p."editorialTaskId" IS NULL OR p."group"<>'editorial-v1-'||p.id;
  IF migrations<>51 OR draft_count<>1 OR invalid<>0
    OR to_regclass('public."EditorialDecisionOutbox"') IS NULL
    OR to_regclass('public."EditorialDecisionResult"') IS NULL
    OR to_regprocedure('postmill_read_editorial_delivery_v1(jsonb,text,text)') IS NULL
  THEN
    RAISE EXCEPTION 'EDITORIAL_CI_RESTORE_CONTRACT_FAILED';
  END IF;
END $ci$;
SQL
echo 'POSTMILL_FULL_PRISMA_BACKUP_AND_RESTORE_CI_OK'
