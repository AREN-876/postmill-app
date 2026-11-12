> Current occurrence-aware implementation: [MAX periodic scheduling](max-occurrence-scheduling.md). The earlier per-Post recovery notes below are historical.

# MAX delivery journal and crash recovery (Postmill v1.4.0, PR #2)

## Decision and scope

Disabling HTTP retries alone leaves a crash window between MAX accepting a message and
Postmill recording the result. Excluding all MAX posts from missing-post-finder would strand
provably unsent work and still allow Inngest step replay and concurrent invocations to send.
Holding a SQL transaction open across HTTP cannot atomically commit with MAX and would add
long-lived locks. A separate attempts table is possible but unnecessary for one text post.

The selected design adds one nullable JSONB field, `Post.maxDelivery`. It is separate from
editable post settings. No Inngest global retry settings or State enum values change. A
compare-and-set on the Post row commits a STARTED marker before calling the MAX adapter.
Only the CAS winner may call it. This is conservative: the marker precedes even the adapter's
read-only checks, so it records permission to attempt, not proof that a POST occurred.

| Durable journal | Meaning | Automatic action |
| --- | --- | --- |
| SQL NULL | This version has not entered the provider send path | Normal claim/recovery allowed |
| READY | Operator authorized one further attempt; no new send started yet | Normal claim/recovery allowed |
| STARTED | An attempt may have reached MAX, or another worker is executing it | Never automatically resend |
| CONFIRMED with receipt | MAX returned a mid and PostgreSQL saved it | Return saved receipt on replay |

STARTED includes attempt number, start time, integration/channel/version snapshot, a SHA-256
digest of the prepared text, and previous operator decisions. The target snapshot remains
available if the post/channel is edited later. CONFIRMED
includes the receipt and operator history; its write also sets Post.state=PUBLISHED,
releaseId and releaseURL in the **same** database update. No token is put in the journal. Notifications/webhooks are not part of this SQL commit;
a terminal crash may omit later side effects even though publication is confirmed.

## Failure boundaries

- Before claim, during sleep, token/media preparation or before the journal CAS: no MAX
  send has started in this attempt. Ordinary stale-claim recovery remains safe.
- CAS commit acknowledgement lost: the caller does not send. If it committed, subsequent
  invocations encounter STARTED and stop. This can require review despite zero sends.
- After STARTED but before HTTP (including adapter validation/read-only checks): conservatively
  uncertain; a crash cannot prove which operation was reached.
- POST accepted but response lost, timeout, response parsing failure, process death after
  receiving mid, or receipt write failing before commit: STARTED survives. No replay sends.
- Receipt commit succeeds but acknowledgement or Inngest step checkpoint is lost: replay
  reads CONFIRMED and returns the saved result without a new MAX call.
- Failure between post-social and update-post, or in later notifications/plugs: the post and
  receipt are already committed. Late error-state writes cannot downgrade CONFIRMED.
- Missing-post-finder first calls resetStalePublishingToQueue. That operation moves stale
  STARTED MAX claims to ERROR with an operator-review message (after three hours since
  update, even beyond the old two-day floor); it requeues only NULL/READY MAX claims.
  Existing Telegram/VK/other-provider recovery retains its normal window.
- Duplicate Inngest events, cached claim steps and concurrent activities all re-enter the
  database gate immediately before the provider call. The atomic CAS admits one attempt.

The existing post-publish function already delegates sending to PostActivity and calls
updatePost in a later step. missing-post-finder already delegates recovery to the repository.
Their orchestration need not be changed: the protection is below both replay/recovery paths.

## Operator procedure (authenticated API; no new UI flow)

1. Read `GET /posts/:id`; the matching entry in `posts` exposes maxDelivery and attempt.
   ERROR plus STARTED means uncertain delivery. Do not interpret this as a successful post.
2. Inspect the target channel and reconcile the outcome. If a message exists, **do not retry**.
   Retain the record and receipt evidence for manual reconciliation; this change does not
   provide a new API for asserting an operator-supplied mid as authoritative.
3. Before considering another attempt, cancel/drain old runs and ensure old processes cannot
   resume. If the operator accepts the remaining duplicate risk, call the existing guarded
   `POST /posts/:id/retry` with:

```json
{
  "expectedAttempt": 1,
  "confirmation": "CHECKED_CHANNEL_AND_STOPPED_OLD_RUNS_ACCEPT_DUPLICATE_RISK"
}
```

The route retains authentication, CSRF, post-update RBAC and billing policy checks. The actor
is obtained from the authenticated user, not the body. The repository checks organization,
ERROR state, exact attempt and STARTED marker by CAS, records actor/time/decision, and grants
READY. Normal retry cannot clear a STARTED/CONFIRMED journal. A failed enqueue after READY
can be retried safely without granting a second send permission. The next CAS increments the
attempt. Old attempt receipts cannot overwrite a newer attempt. Audit history is retained.

## Migration and rollout limits

`20261112080000_max_delivery_guard` adds nullable JSONB. Existing MAX QUEUE/PUBLISHING/ERROR
rows are conservatively marked STARTED/ERROR with attempt 0: pre-journal execution cannot be
proved unsent. Other providers and published rows are untouched. Existing MAX queued posts
therefore require review after this migration; this is intentional, not silent data loss.

**No deployment was performed.** Any future rollout must stop/quiesce old publishing workers
before applying the migration and starting new code. A mixed deployment with old workers
that do not check the journal cannot enforce this guard. The SQL was executed on an isolated,
throwaway local PostgreSQL database; it has not been applied to either VPS or the shared dev DB.

This is not exactly-once delivery: MAX has no idempotency/reconciliation contract here. Unknown
delivery sacrifices automatic eventual delivery to avoid automatic duplicates. Manual repeats,
new post records, external channel activity or restoring PostgreSQL to an older backup can
still duplicate a message. The guarantee assumes committed PostgreSQL state is durable and
all publishing workers use this code. Operator confirmation cannot fence a still-running old
HTTP request: old workers must actually be stopped, not merely assumed cancelled.

## Verification

Real PostgreSQL tests exercise the production repository and PostActivity with a synthetic
provider, including migration/backfill, safe pre-send recovery, post-acceptance DB failure,
timeout, atomic receipt/state, lost commit acknowledgement, step replay, eight concurrent
activities, org/attempt-bound manual retry and Telegram/VK recovery. Tests do not contact MAX.
The Inngest cloud scheduler itself is not started: its activity replay boundary is exercised
directly. Separate service tests verify rejection of an unconfirmed manual retry.

Commands:

```sh
pnpm prisma-generate
pnpm exec vitest run --root libraries/nestjs-libraries --config vitest-integration.config.ts max-delivery.int-spec.ts
pnpm exec vitest run --root libraries/nestjs-libraries src/inngest/activities/post.activity.spec.ts src/database/prisma/posts --maxWorkers=1
pnpm exec vitest run --root apps/backend --maxWorkers=1
pnpm exec vitest run --root libraries/providers max/src kernel/src/domains/social-base.spec.ts kernel/src/__tests__/all-providers.conformance.spec.ts kernel/src/__tests__/kernel.metadata.spec.ts kernel/src/__tests__/oauth-state.guard.spec.ts --maxWorkers=2
pnpm run build:backend
pnpm exec tsc --noEmit -p apps/frontend/tsconfig.json --incremental false
```
