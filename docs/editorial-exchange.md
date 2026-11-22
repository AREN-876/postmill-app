# Editorial Exchange — Postmill 06A–09B (test-only, default-off)

Related: [Editorial Engine #16](https://github.com/AREN-876/max-editorial-engine/issues/16), [#36](https://github.com/AREN-876/max-editorial-engine/issues/36), [#42](https://github.com/AREN-876/max-editorial-engine/pull/42). This document preserves historical 06A/06B design notes. Later increments add separately gated machine/session routes and a default-off Inngest decision sender, but this PR does not activate them, migrate the live database, or authorize any publication. The final **Test operator workflow** section describes the current implementation.

## Why a separate managed draft path

Existing native campaign draft approval is a single approvalStatus (pending/approved/rejected). The native approve/reject methods set that field, and promotion and changePostStatus check it. createOrUpdatePost generates a fresh group UUID on edit; native scheduling/now, retry, date changes and other paths are not the right authority for a two-stage reviewed story. Preserve native behavior for unmanaged posts, which continue to have NULL Editorial identity.

- New nullable Post.editorialTaskId and editorialProfileRef identify an opted-in draft (canonical positive bigint decimal string and pinned profile reference). A unique org/task key prevents duplicate managed entries for the same Editorial Engine instance. The protocol assumes one trusted engine/ID namespace per org; multi-engine tenancy needs a versioned namespace before activation.
- Managed group is server-assigned `editorial-v1-${post.id}`, globally unique by Post primary key. The SQL constraint reserves this prefix from ordinary posts. This deliberate choice avoids group-rotation and a race with ordinary post/group writes. Actual composer, import/export, routing and list compatibility must be qualified before activation; no managed draft creation endpoint exists yet.
- Managed row must be a fresh single MAX story draft in an existing enabled org-owned MAX integration and active org-owned campaign; no parent, recurrence, native approval, deletion, release or schedule revision. A draft flag cannot be applied retroactively or removed. All semantic changes and deletes are frozen; only operational fields (updatedAt, commentCount, lastViews/lastLikes/lastComments) may change. The database constraint/trigger catches native write paths regardless of controller. Native approval is NOT text approval. SQL guard is not a substitute for auth, full group/child validation, or the eventual artifact-bound release check.
- MaxOccurrences.active explicitly refuses managed identity before planning/claiming/sending; the publication handler and PostActivity.postSocial also stop managed rows before delivery, including stale repeat events. Existing MAX delivery logic is otherwise unchanged. DB fence does not prevent a user with ordinary posting privileges from separately composing an unrelated unmanaged copy; service token must be limited to managed paths, not generic scheduling. Do not create managed rows manually, even on test until controlled API and cleanup path exist.

## Historical 06A roadmap (later increments detailed below)

1. Authenticated scoped machine API: idempotent create of a single normalized story draft under the same transaction/unique key, stable identity, immutable revision references and exact content reconciliation. No ordinary publication API permissions for machine principal. Human RBAC/CSRF via existing authenticated campaign surface; explicit actions approve_text/request_text_changes/request_image/request_image_changes/confirm_image_reuse/approve_final/reject; never interpret ordinary comments as commands. Avoid accepting actor/org from user body.
2. Durable revision state and append-only outbox in Postmill, atomic with each decision. Event v1 exactly matches Editorial-013 JSON, bigint task/seq as strings; exact binding/sequence/content; replay original receipt, reject conflicting ID/stale events. Scoped GET reconciliation, no direct database exchange or general API-key elevation. No batch or paid dispatch from Postmill.
3. Replace temporary full freeze with audited version-aware state transitions and final content-bound release guard. Controlled edits retain group, invalidate appropriate approval, keep history. Reuse native scheduling only after final exact-pair approval and server-side checks at promotion, update, direct/recurring/retry, MAX occurrence claim and send. Until that PR passes, guard stays closed. Verify all routes and any related records/parent-child links; test channel only, native draft and manual publish regressions mandatory.
4. Editorial side: authenticated importer/outbox consumer and read-only reconciliation, event dedup, no operation until separately approved. Image generation/reservation is a separate module. Never activate RSS production AI as part of this work.

## Testing / deployment
Focused PostgreSQL 17 CI uses the exact migration against a disposable minimal pre-migration schema fixture; it does not prove whole Prisma schema drift or installed-version compatibility. Full Test CI covers prisma migrate deploy, migration drift, normal regressions; run before merge. No changes to existing migrations, releases, image tags, StoryGo Gateway, config or runtime. Before any eventual deployment coordinate explicit migration/backups and qualify actual installed version, all routes, CSRF/RBAC, transport, cleanup and release guards. Do not deploy 06A independently to production.

## 06C: one-command read-only VPS readiness inventory (not activation)

The working VPS can legitimately have fewer migrations than `main`. Before any
deploy, use `python3 tools/deploy/editorial-readiness --check` from an approved
checkout of this fork **on the VPS**. It requires local Docker CLI access and
uses fixed `docker inspect` plus `docker exec` with `BEGIN READ ONLY`; it
never pulls an image, alters a file/role, migrates, creates a draft, exposes
Postmill secrets, or contacts MAX. Output is a bounded inventory containing
the image reference, container health, completed/unfinished migrations, the
nine Editorial migration states, and counts of enabled MAX integrations and
active campaigns. It does not report IDs, credentials, or editorial content.

The same `--check` now compares the live Postmill `_prisma_migrations`
ledger (44, 51, 52 or 53 completed rows) against the exact SHA-256 of each
`migration.sql` in the **local full 53-file fork checkout**. A missing source
tree, changed migration checksum, missing/extra migration, incomplete or
rolled-back entry is a hard refusal; only counts/status are printed, not raw
ledger checksums, PostgreSQL errors or secrets. This is read-only and does
not execute the migration SQL. Correct checksums prove migration-file provenance
only, not live schema equivalence, data integrity, or deployment authorization.

A successful `--check` invocation means **only that the inventory succeeded**.
`schema_installed` is a necessary DB condition, not runtime readiness.
The tool deliberately leaves module activation, test-org/target mapping,
Editorial-014B role/HTTP/DB connectivity, backup restore, publication fences
and deployment permission as NOT_VERIFIED/false. There is **no `--apply`**,
no migration runner and no silent operational change.

Current 2026-11-20 VPS evidence: image created November 16, 44 committed
Prisma migrations, last `20261114090000_max_target_binding`, all then-existing
Editorial migrations NOT_APPLIED, no `Post.editorialTaskId` or
`EditorialDraftReceipt`, no active Campaign, and the Editorial task #4's
channel alias `test:terra-v2` is not an Integration ID/internalId in the
installed Postmill database. The one enabled MAX integration is not
authorized as a test target. An image replacement is **not** a DB migration,
and `postmill-update` intentionally refuses schema drift without reviewed
fingerprint. Only after a separate backup+isolated restore and a reviewed
test-only cross-service exercise may a unified one-time deployment be
approved. Do not bypass the guard or create a synthetic target in production.

## 06B-1: offline initial-draft admission (no route)

The existing PublicAuthMiddleware stamps generic API keys and OAuth as integrators; they are not dedicated Exchange capabilities. Do not provision or reuse them for Exchange. `prepareEditorialDraft` implements a deliberately separate, unregistered and test-only admission boundary. Trusted server configuration (not the request) must supply one exact org/integration/campaign/Editorial-channel/profile/image-mode scope, `is_test: true`, SHA-256 digest of a CSPRNG `edx_v1_<64 lowercase hex>` secret, and expiry (UTC milliseconds). Header is exactly `Authorization: Bearer edx_v1_…`. Missing/expired config fails closed. The future transport must apply this boundary on every machine request, without native auth fallback, logging the credential, or enabling this through a generic key. Credential provisioning, rotation/revocation, HTTPS/internal transport and rate limiting are not implemented here; configure no live key yet.

Initial request JSON exact keys: schema_version=1, task_id (positive signed-int64 decimal string), org_id, integration_id, campaign_id, channel_id (positive signed-int64 decimal string), profile_ref, is_test=true, image_mode, text={revision:1,sha256}, content={title,parts:[three strings]}. Tenant/target claims must equal trusted scope. The Editorial-013 snapshot binding does not include channel_id or campaign_id: these extra create-time assertions are not added to its later event binding. No caller-supplied post/group IDs, image, schedule, state, approval, actor or arbitrary settings. Exact hash uses Editorial's PostgreSQL jsonb::text UTF-8 of the two-key content object (parts then title; comma-space and colon-space, JSON string escaping). The PG17 fixture independently verifies the same Cyrillic/emoji/control-escape vector as the TypeScript test. Not a generic JSONB canonicalizer. Native StoryGo validator checks the full first part = title + two LF + part1, remaining parts joined by exact divider; no silent normalization, first part including title <=4000 UTF-16 units. Conservative initial test-only admission rejects markup/entity-like text pending composer/UI round-trip qualification. This intentionally may reject a format-valid Editorial artifact; never edit it silently or grant approval.

Next: scoped repository transaction, unique org/task durable receipt + native DRAFT in one transaction; authenticate before reading any state; bind exact source content/digest and stable server-generated group; compare actual current target eligibility from authoritative DB and test mapping, verify native content/settings round-trip and related group/child isolation. Replay same canonical request returns original receipt, changed request is conflict. No Redis TTL as sole idempotency storage. Bridge sequencing: Postmill creates fenced draft, Editorial owner calls start_review with verified IDs, compare resulting text revision/hash and binding; pending or unknown acknowledgement never permits human decision or publication. Recover by scoped read and same request replay, not new draft. No human actions/outbox, image generation, route or integration activation in 06B-1; 06A full freeze remains. All subsequent modules and tests required before deployment.

## 06B-2A: transactional initial receipt (inactive)

Stacked on 06B-1. New additive migration creates `EditorialDraftReceipt` with immutable exact prepared JSON and one-to-one restricted FK to Post. Invoker-only SQL function `postmill_create_editorial_draft_v1(jsonb)` (PUBLIC EXECUTE revoked) is reachable only through a parameterized repository adapter, not a registered endpoint. It expects trusted 06B-1 output; database is NOT the authentication boundary. READ COMMITTED, per-org/task transaction lock, existing unique org/task key, current organization-owned live MAX integration/campaign row locks; recheck target on retry. Database reconstructs native content/continuation and checks the canonical Editorial-013 hash. JS admission remains responsible for full UTF-16 and markup validation. Server generates a 32-hex ID accepted by existing isCuid validator and stable editorial-v1- group; native DRAFT/pending, no image, creationMethod API, no dispatch. Date is only draft metadata. Same prepared request returns the original binding/text receipt with created=false; different request or untracked 06A draft fails closed. Receipt and Post commit together; no Redis cache as authority. Receipt is initial historical evidence, never current review state.

Remaining activation gates: dedicated authenticated/limited HTTP transport (including raw JSON duplicate-key policy, bounded request, error mapping, key lifecycle and no generic auth fallback), authoritative test-channel mapping/provider eligibility, scoped read reconciliation, Editorial start_review acknowledgement and exact hash verification, native composer/read/UI compatibility, related parent/child isolation and export/import protections, controlled cleanup/revision lifecycle, human decisions and outbox. Full 06A fence preserved; no endpoint, no test/production dispatch or deployment. SQL CI fixture uses actual migrations but minimal schema; full Prisma migration drift/Build/Test still required.

## 06B-2B: private machine transport and target-pinned reconciliation (inactive)

Private routes prepared in `EditorialExchangeModule`: POST /internal/editorial/v1/drafts (exact 06B-1 request, 200 created/replayed) and GET /internal/editorial/v1/drafts/:taskId (no body/query; scoped historical receipt + native verification). Module is NOT imported by the runtime; configuration provider is null. No secret or target configured, no public SDK/OpenAPI change. The separate credential is checked before DB access; duplicate Authorization, unsupported content encoding, non-exact compact UTF-8 JSON.stringify body (including duplicate keys) or >100000 raw bytes fail closed. Both operations require trusted server-supplied targetInternalId, matching actual MAX integration. HTTP errors intentionally contain no SQL/credential/artifact data; 503 means unknown, reconcile by GET or exact replay, do not create a different task. No cache, no scheduling, no human/final approval. GET only returns a receipt verified against current Post, target, SHA and exact native payload, not content or integration secrets. Missing and out-of-scope both 404; target drift and anomalies 409. GET acquires locks, no data writes. `review_acknowledged=false` until later bridge handshake.

Additive migration captures immutable actual target in receipt on insertion: internalId, provider version/config identity, hash of encrypted token; never returns it. Pre-existing inactive receipts lack target evidence and cannot be adopted. Creation wrapper verifies configured target under transaction lock, invokes original atomic create, verifies same receipt against actual native DRAFT, detects any existing child/group contamination and fails atomically. Read is not proof of future eligibility; all eventual mutations/sends must recheck under lock. This detects existing child links, not a global child-insertion guard. No production activation until test mapping independently verified, complete authorization/transport, telemetry/body redaction, request size at reverse proxy, cleanup/child guards and UI qualification. No env key source, AppModule wiring, deploy or paid action in this increment. Actual network/signed transport integration and DB concurrency validation required before use.

## 06B-3A: initial review anchor and transactional decision outbox (inactive)

Normative upstream: AREN-876/max-editorial-engine commit 9d4af55e4060860512f108667200eed45539764f, docs/editorial/review_contract.md and sql/editorial/013_review_ledger.sql (core.start_review, core.review_snapshot, core.apply_review_event). The existing native Postmill approval mechanism is not the Editorial decision state. No change to Post content, approval, schedule, or the 06A publication fence.

- `EditorialReviewAnchor`: one immutable initial snapshot per managed draft receipt. Trusted future bridge must supply the authentic response from Editorial; SQL only verifies exact initial state against locked native draft/target/receipt. Binding, revision/hash, mode, zero sequence, pending text, null image; automatic/after_text_approval initial intent must equal initial:1; manual/disabled null. No inferred acknowledgement based on creation alone. Exact repeat returns historical anchor; no reset/re-anchor to a later snapshot. Canonical JSONB UTF-8 SHA-256 stored and checked. Existing create/read endpoint contract remains unchanged: review_acknowledged=false until subsequent handshake wiring.
- `EditorialDecisionOutbox`: immutable event and hash, stable server event UUID/UTC timestamp, one retry key per post, one event per expected sequence. In this increment the anchor is only seq 0, and any second distinct command for that post is blocked until a later receipt/reconciliation implementation. Command exact keys command_id (client-generated lower-case UUID retry key), expected_seq, action, text, image, feedback. Trusted context supplies actor, scope and target outside command. SQL revalidates current native DRAFT and target, rejects missing anchor/stale refs/invalid feedback. Allowed initial actions: approve_text, request_text_changes (nonblank <=4000 code points), reject, request_image only manual. All other actions fail closed until current authoritative revised state can be verified. Event has exactly the 13 Editorial-013 keys including producer=postmill, actor_id, binding, expected_seq, action, text, image, feedback, request_id=null, revision_content=null. Payload is committed with the decision as the sole durable record. No independent mutable status/optimistic approval. Same scoped command/actor/content returns exact event and SHA with newly_queued=false/replay=true; changed replay conflicts. Current target verification is still mandatory even for replay; a historical outcome query is a later transport feature. Both first and replay return remote_status=unconfirmed, dispatch_authorized=false, publishable=false.

Invoker-only functions (PUBLIC EXECUTE revoked), parameterized inactive repository adapters. SQL is not authentication: the future bridge must verify Editorial identity and response; the future human route must derive actor from authenticated authorized Postmill session (org RBAC + CSRF, no machine impersonation) and bind exact current task. No route, credentials, network delivery worker, polling/leases, remote event acceptance or receipt import, revisions, media, paid calls, scheduler changes or deployment. A queue entry is not permission to generate. Next 06B-3B: authenticated authoritative accepted/rejected receipt ledger, acknowledgement/reconciliation with exact event hash and resulting sequence, durable transport and later decisions; keep errors or uncertainty quarantined. Actor membership/target/channel mapping and stale race checks must be qualified before activation. SQL fixtures use synthetic snapshots and real disposable PG17, not actual Editorial or MAX traffic. Full CI schema drift/coverage/build still mandatory.

## 06B-3B: result receipts and confirmed same-artifact sequence (inactive)

Normative source remains Editorial-013 at AREN-876/max-editorial-engine 9d4af55e4060860512f108667200eed45539764f. New `EditorialDecisionResult` is immutable, one row per outbox event, restricted FK, canonical JSONB UTF-8 SHA-256. The actual `core.apply_review_event` response has exactly seven fields (status, reason, state, dispatch_authorized, publishable, newly_applied, replay) and does NOT include event_id or payload hash. The future authenticated bridge MUST correlate the authentic response or authoritative remote event-log read with the exact submitted event ID and canonical payload digest. The SQL import function validates this correlation supplied by trusted context, but is NOT remote authentication or a signature verifier. No callback endpoint or delivery mechanism here.

Under the same org/task reconciliation lock, import checks current native DRAFT, target, scope, existing event and digest, exact response shape, boolean replay semantics and both safety flags false. Accepted result must equal the independently derived Editorial-013 state transition, including seq+1 and unchanged native artifact refs; rejected result must equal the previous confirmed state, with a reason. Divergence or unknown response leaves the event pending and blocks new decisions. Historical exact replay ignores only transient newly_applied/replay flags, returns the original immutable outcome; conflicting replay fails closed. Stored rejected outcome blocks new commands at that sequence until a separate explicit recovery protocol; no reset/retry under new ID. Existing unique (postId, expectedSeq) stays intact.

Last confirmed state is derived from the immutable anchor and latest accepted receipt, not an optimistic mutable flag. Private repository read reports review_acknowledged (anchor exists), status idle/pending/rejected (local outbox status, NOT review rejection), latest_event_id and last_confirmed_state with remote_current_verified=false. It does not prove current remote eligibility or absence of later external changes. A terminal review can have idle outbox but rejected=true in the state. Exact retry of a queued command returns its historical remote status without a second event. After accepted receipt, next valid same-artifact command can advance sequence: approve_text, request_text_changes, reject, request_image when 013 allows. A returned text cannot be re-approved until verified revision installation; paid/image work, image revisions, external state changes, controlled rejection recovery, later reconciliation and final approval with image remain separate. No native Post content/approval changes, dispatch or publish permission ever returned, including disabled-mode final_approved=true in historical Editorial state.

Additive migrations + parameterized repository adapters only. The original inactive create/read API remains unchanged; no route registration, authenticated remote transport, credential changes, human actor authorization, outbox worker, or real Editorial/AI/MAX calls. PG17 fixture independently expresses expected 013 transitions on synthetic native drafts; it is not a live cross-service test. Full integration, signed/authenticated transport, independent current target/membership checks, actual revision install and publication guards are activation prerequisites. Verify all CI; never deploy merely because a historical receipt matches.

## 06B-3C: dormant authenticated Editorial transport

Paired receiver: AREN-876/max-editorial-engine issue #45 / draft PR #46; see its docs/editorial/exchange_transport.md. The Editorial Engine has no live HTTP service as of 06B-3C development. The Python receiver is opt-in loopback only; no runtime DB role, TLS proxy or secrets are installed. **This is a compiled, mocked/tested integration path, not a functioning production connection.**

Postmill's `postmill_read_editorial_delivery_v1` reads exactly one pending immutable `EditorialDecisionOutbox` record only after current native DRAFT/target verification. It never claims/deletes/times out a decision or changes native approvals. As of the later operator increment, `EditorialDeliveryService` **is registered** in the Inngest module and exposes `deliverPending` (durable SQL reservation before one signed `submit`, then signed read-only `lookup`) and `reconcileOnce` (lookup only). The five-minute cron is registered but its activity is a no-op without exact test-only server gates. The old unreserved `attemptOnce` was removed and **must not be used**. Any timeout, unsigned/wrong event reply, network failure, 5xx or ambiguous result stays pending; never repeat `submit` after a reservation. A signed lookup returning found=false means UNKNOWN, not rejected. The SQL import function from 06B-3B remains the final state-transition gate.

**06B-local revision (single VPS only):** The original public HTTPS/DNS proxy design is superseded before activation. The sender now pins the literal `http://127.0.0.1:8794` and rejects all configurable origins. Only two exact POST paths can be requested; a dedicated loopback-only fetch never relaxes the global `safeFetch` SSRF policy, and redirects are forbidden. The receiver stays bound to `127.0.0.1:8794`. These processes must share the **Postmill container network namespace**, for example via a separately approved sidecar with Docker Compose `network_mode: service:postmill`, not merely run on the same host or Docker bridge. No port mapping, host/public listener, external reverse proxy or DNS is needed; absent matching namespace, delivery fails closed. HMAC retains independent 256-bit request/response keys, bounded timestamps, CSPRNG nonce, exact event ID, canonical PostgreSQL JSONB digest and signed bounded response. Human RBAC remains distinct.

The SQL 013 outcome and immutable receipt do not grant image cost, publication or scheduling authority. Future activation requires verified Editorial-014B least-privilege role/ACL, a sidecar sharing Postmill's network namespace, secure configuration/secret rotation, an actual end-to-end loopback+PostgreSQL test, authorized Postmill human workflow, outbox reconciliation, authoritative live state validation, and production publication guards. No credential creation, deployment, migration apply, open API or paid call is done here. Synthetic tests and the PostgreSQL fixture are not evidence of the currently installed VPS configuration.


## 06B-4A: dashboard human review (disabled by default)

The **session** API is distinct from the private Editorial machine ingress and
the signed 06B-3C remote bridge. New routes:
`GET /editorial/review/:postId/:taskId` reads the current frozen native DRAFT,
its three text parts and historical Editorial-013 confirmation. It does not
assert that the remote state is currently synchronized.
`POST /editorial/review/:postId/:taskId/decisions` accepts ONLY
`{command_id,expected_seq,action,feedback}`. The `command_id` is a persistent
client-generated UUID retry identity; `expected_seq` is the string seen on GET.
Valid actions are `approve_text`, `request_text_changes`, `reject` and
`request_image`; only text-change feedback may be nonempty.

Both routes belong ONLY to `EditorialHumanReviewModule`, with its own
`authenticatedController` list bound to AuthMiddleware, CsrfMiddleware and
OrgRbacGuard. `AppModule` imports this module **conditionally at bootstrap**
when `editorialSessionRoutesEnabled(process.env)` validates the exact test
organization and `max:-73052031470103` target. With the default-off gates,
the module is not imported and the routes do not exist. `ApiModule` never
registers these routes. When enabled, GET requires `posts:read`, POST
`posts:update`; the controller rejects API/header credentials, impersonation
and requests without the `auth` cookie, while the service independently
verifies organization membership and permissions (including admins).
The actor ID is resolved server-side; browser-supplied actor/org/target is
never trusted. Native release and machine ingress have independent gates.
The registered Editorial Inngest delivery cron remains inert without its
own independent delivery/session/test-target configuration.

SQL functions `postmill_read_editorial_human_v1` and
`postmill_queue_editorial_human_v1` derive the immutable scope and target from
the Postmill receipt, lock the org/task, revalidate DRAFT/target, and delegate to
existing 06B-3B review/queue functions. The browser cannot supply text/image
hashes, organization, actor or live target. A queued decision returns
`status=queued/unconfirmed`, never native Post approval, payment approval,
a completed Editorial decision, schedule or publication. Invalid, stale,
cross-tenant, changed-target and duplicate-command-conflict requests fail
without publishing; exact retries reuse the historical event. A failed audit
write does not requeue a paid or remote operation. The audit metadata contains
event/task/command IDs and action only, no text, feedback, provider secrets
or signed transport keys.

The included PG17 fixture proves database scope/race/idempotency checks on
synthetic data, and the HTTP tests cover actual cookie AuthMiddleware/CSRF,
RBAC, extra body fields, viewer/cross-org rejection and unknown outcomes.
These are **not** a live Postmill-Editorial integration test. Activation of
any bridge, migrations or production deployment remains separately gated.

## 06B-local: shared-network-namespace deployment contract (inactive)

This is **not** a general private-network URL allowlist. The sender is hardcoded
to `http://127.0.0.1:8794`; changing `SSRF_ALLOWED_PRIVATE_CIDRS`, weakening
`safeFetch`, using a Docker service name/private IP, or routing through the
public nginx reverse proxy is prohibited.

The separately approved receiver should be a small non-privileged sidecar,
isolated from Postmill's filesystem and credentials and sharing **network only**
(e.g. Docker Compose `network_mode: service:postmill`, with no `ports` and
no host networking). It must retain the restricted Editorial database login,
single disposable test org, checked `edx_bridge` functions, independent HMAC
keys stored outside git/logs, bounded requests and loopback bind. Do not
install Python inside Postmill's image or change the general SSRF filter.

This reduces network components, but **does not complete activation**:
conditional session/machine modules and the test delivery cron exist in code,
but their runtime gates are off by default. No sidecar, secrets, credentials,
or active sender are installed by this PR. No VPS, MAX or paid AI calls in CI;
CI PostgreSQL exercises only isolated disposable databases. Before any runtime installation the
operator must separately approve a test-only deployment and real loopback
HTTP + PostgreSQL + Postmill end-to-end idempotency tests (lost response,
cross-org denial, wrong MAC, stale target). Unknown outcome remains queued
and unconfirmed; no implicit paid retry or publication.

## Test operator workflow — signed outbox delivery and embedded review panel

The tested Editorial → Postmill DRAFT → human approval → native MAX release
path is now available behind independent server-side gates. This section describes the current code and supersedes older "unregistered"
claims above. These features remain **inactive on the VPS** until separately
approved deployment and explicit per-feature test-only activation; historical
06A/06B notes document earlier stages.

- The fork image embeds `EditorialReviewSession` in an existing Postmill
  post-details modal only for a frozen editorial DRAFT on the exact
  `max:-73052031470103` integration. Public/default Docker builds keep the
  compile-time UI flag off. Cookie authentication, CSRF, org RBAC and native
  immutable target checks are still server-side, independent of the UI.
- The `editorial-test-delivery-sweep` Inngest function is registered at
  backend bootstrap **only** when the exact test-org/session/target/delivery
  gate is enabled. Restart and re-sync Inngest after a separately approved
  activation; disabled installations do not schedule the cron or write run
  records. A second execution-time guard refuses already queued runs whose
  test gate was removed, before touching the run ledger or mounted secrets. It scans a maximum of ten
  pending decisions for exactly one configured test organization and target.
  It does NOT publish to MAX, execute paid AI, generate images or edit text.
- `EditorialDeliveryReservation` is an additive, append-only, per-event
  durable submit-once fence. The SQL invoker function
  `postmill_reserve_editorial_delivery_v1` revalidates the current frozen
  draft, bound org/task/target and exact pending event under the advisory lock.
  The first reservation is COMMITTED before the signed HTTP submit. Later
  sweeps use only signed `lookup`, including after an ambiguous HTTP result.
  A crash between reservation and first send therefore causes an UNKNOWN
  event requiring operator investigation, never an automatic retry.
- Both HMAC hex keys must be mounted **read-only into the Postmill container**,
  accessible to its unprivileged `app` user at:
  `/run/secrets/postmill_editorial_request_hmac_hex` and
  `/run/secrets/postmill_editorial_response_hmac_hex`.
  Never put those keys in Compose `environment`, Docker inspect,
  source control, CI variables, Inngest payloads or logs. The sidecar keeps
  its existing independent credentials/mount.
- Activation requires all of `EDITORIAL_TEST_SESSION_ENABLED=true`,
  `EDITORIAL_TEST_DELIVERY_ENABLED=true`, exact `EDITORIAL_TEST_ORG_ID`
  and `EDITORIAL_TEST_MAX_TARGET=max:-73052031470103`. The release
  gate remains separate: `EDITORIAL_TEST_RELEASE_ENABLED` does NOT
  participate in decision delivery and a final approval NEVER schedules or
  publishes. The operator still explicitly authorizes `publish_now` or
  `queue` using the protected release endpoint.

Deployment order: back up Postmill; apply the committed additive Prisma
migration with the approved `migrate deploy` flow; build/test and pin the
new fork image; provision group-readable, root-owned secret files for the
Postmill runtime user on a **read-only** mount; prepare Compose changes in
the third overlay (not the image-only fourth overlay); recreate Postmill
and its Compose-managed network-namespace bridge together; verify signed
read-only lookup and session APIs; only then enable the independent delivery
gate. No new MAX request is part of deployment. Keep `--sdk-url` and SDK
serve origin/path pointed at the working nginx `postmill:5000/api/api/inngest`
endpoint for this installation, not `postmill:3000`.

If a decision is reserved but its lookup remains missing/unknown, STOP:
do not delete its reservation, generate a new command, manually re-send or
replay a paid request. Inspect exact event/receipt state, then resolve
through an explicitly audited operator procedure. The prior frozen DRAFT,
result ledger and MAX occurrence journal are never reset.
