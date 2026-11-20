# Editorial 07 — one-time Postmill upgrade: release gate (NOT authorization)

**State:** design / CI verification only. No migration, image update, service
registration, new credential, login role, sidecar, or MAX activation is approved.
No `--apply` runner exists. This document must not be used as authority to
execute production operations without a separate user-approved release review.

## Verified baseline on 2026-11-20

- Running image: `ghcr.io/aren-876/postmill-app@sha256:643d6d6ed7710c89bddf466928a3bfc7d310ceaaabe19ce21aa0238f93336e4d`.
- Postmill DB: `postmill-db-local`, 44 successful migrations, none pending.
- Seven 06A–06B migrations dated Nov 19–20 are absent; both
  `Post.editorialTaskId` and `EditorialDraftReceipt` are absent.
- One enabled MAX integration **is not an authorized test integration**.
- No active Postmill campaign.
- Editorial task #4 is ready but its alias `test:terra-v2` is not a matching
  Postmill Integration `id` or `internalId`; there is no native DRAFT.
- Editorial 014B bridge SQL exists, but `editorial_bridge_v1` is still
  `NOLOGIN` with an empty organization allowlist.
- Postmill machine and human review modules remain **unregistered by design**,
  configuration null, sender delivery service unregistered. A database upgrade
  alone does NOT activate a bridge.

## What isolated CI actually proves

1. Postmill 06A–06B PG17 migration and guard fixtures on a *minimal* fixture.
2. Editorial 001–014B SQL and role restrictions in disposable PG17.
3. Synthetic real Node 24 signer ↔ Python receiver HMAC/HTTP on loopback.
4. Real two-database SQL draft ↔ review event ↔ result round-trip, but the
   Postmill side uses a minimal fixture and the Editorial side a generated task.
5. **Editorial 07**: full 51-migration Prisma schema, dormant *real* Nest HTTP
   create/read with real Postmill SQL/Prisma, synthetic one-org MAX row and
   campaign. Afterward, `pg_dump -Fc` and `pg_restore --exit-on-error`
   reconstruct the exact frozen DRAFT in a second disposable CI database.

None of these tests installs a production module or exercises native MAX
delivery, production permissions, or the user's actual Editorial task #4.

## Required checks before a one-time update

- All four outstanding PRs (#30 and #31 in Postmill; #50 and #51 in Editorial)
  have clean CI and have been reviewed/merged in a known order. Pin the exact
  fork SHA and resulting digest; no floating `latest` tag. Avoid deploying an
  image simply because its source branch exists.
- On an isolated full-schema clone, test **the same seven production migrations
  applied over a 44-migration restored baseline**, not just a fresh empty DB.
  Check locking/downtime and check for unknown production schema drift.
- Design an authoritative, revocable, **test-only** organization/integration/
  campaign/channel mapping. Never relabel the existing enabled MAX target as
  synthetic merely to pass CI. The schema currently cannot prove test identity
  from an Integration row alone.
- Independently review: runtime module registration, auth/machine secret
  provisioning, HTTP body bounds at reverse proxy, session RBAC+CSRF, metadata
  redaction, UI/composer/import/export behavior, group child constraints,
  operator-only review handshake, secret rotation, readonly HMAC reconciliation,
  and no publication/paid-work path.
- Confirm the running Docker Compose files and the existing
  `postmill-update` constraints, including unchanged non-Postmill containers.
  The updater intentionally refuses unreviewed schema differences.

## Candidate controlled release order — do not execute yet

1. **Freeze/record current state** and maintenance window: current git release,
   image digest, Docker networks/mounts, last Prisma migration ledger, PG version,
   available disk/backup capacity, recent errors, current MAX delivery status.
2. **Back up the entire `postmill-db-local`** with PostgreSQL 17 `pg_dump -Fc`
   (not merely the Editorial database) to a unique restricted path. Record
   timestamp, byte count, SHA-256, source DB/PG version, and retain immutable
   copy outside the service's PostgreSQL volume. No secrets in log output.
3. **Restore the same backup into a disposable PG17 container with
   `--network none`**, no production volume mounts and no published ports.
   Check restore exit status, expected 44 migrations, business row counts,
   schema constraints and representative data. `pg_restore --list` **alone
   is not** a restore drill. Preserve the drill report.
4. **Stage candidate image** by exact Git commit SHA and verify digest,
   provenance labels, target Prisma manifest, and unchanged Compose service
   specification. Build separately; do not rebuild on the VPS.
5. **Test the seven migrations on the restored clone**, using the exact target
   image's committed migration files and `prisma migrate deploy` guarded
   by its normal migration ledger. Check for unexpected files/migration drift,
   constraints, old data retention, and post-upgrade health on an isolated
   full-stack fixture. No arbitrary SQL `db push`.
6. **Separate explicit operator approval** before any real DB mutation,
   `LOGIN` enablement, service restart, or real MAX operation.
7. During the agreed maintenance window, perform the reviewed migration against
   **only** the production Postmill database, verify the exact 51-migration
   ledger, then use existing `postmill-update` for a single-service image
   switch with the pre-reviewed target schema fingerprint. Validate health,
   login, ordinary DRAFT/QUEUE, MAX guards, and no other container restarts.
8. Keep machine exchange, human review controller, transport sender and Python
   sidecar **disabled** after the schema/image update. Activation is a different
   change, gated by verified test mapping/credentials and end-to-end smoke.
9. Post-release, retain the old image, compose files, backup, checksum,
   migration manifest and operator log until the monitoring window closes.

## Failure / rollback boundaries

- If preflight, backup, clone restore, 44→51 rehearsal or fingerprint validation
  fails, **stop without touching production**. Repair the rehearsal first.
- If the image health check fails after a schema update, `postmill-rollback`
  can restore the **old image only**. It does **not roll back PostgreSQL**.
- Do not blindly execute `prisma migrate reset`, `db push --accept-data-loss`,
  reverse handwritten SQL or automated DB restore. With production traffic
  continuing after a migration, restoring a pre-upgrade backup can lose posts,
  schedules or MAX delivery state. Any point-in-time DB recovery needs an
  explicit outage, reconciliation plan and user authorization.
- Tests use completely synthetic MAX tokens: no actual MAX client, publication,
  paid image generation or AI requests. All managed posts stay frozen DRAFT.

## Operator UX goal

Until the hard gates pass, there is one existing read-only operator command:
`python3 tools/deploy/editorial-readiness --check` (from Postmill PR #30,
after deploying that script to the VPS without activating any endpoint).

Only **after** all gates pass should a small, reviewed orchestration script be
considered for `--apply`; do not prematurely automate an irreversible
database migration and pretend image rollback also recovers database state.
