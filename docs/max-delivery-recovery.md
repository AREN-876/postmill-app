# MAX delivery recovery and rollout

Current design: [durable occurrences](max-occurrence-scheduling.md). MAX-02 adaptation:
[compatibility analysis](max-02-compatibility.md). This document supersedes the older per-Post-only guard.

## Delivery boundaries

| Failure boundary | Recovery |
| --- | --- |
| Post committed, initial journal missing | Missing-post-finder creates one READY intent from the frozen target. |
| READY before claim | Safe automatic recovery; no send was authorized. |
| STARTED committed, before/during provider GET or POST | Outcome conservatively unknown; no automatic new attempt. |
| MAX accepted POST, process dies before receipt commit | REVIEW after stale timeout; retain attempt and target, never announce success. |
| Receipt/Post transaction committed, response or durable checkpoint lost | Saved CONFIRMED receipt; replay does not POST again. |
| Later notification/webhook fails | Cannot downgrade confirmed delivery or reopen send permission. |

No PostgreSQL transaction spans HTTP. HTTP POST retries are disabled only for MAX message
writes. The common Inngest function may retry execution, but every send re-enters the locked
PostgreSQL occurrence/attempt gate. Unknown delivery blocks that occurrence, not future releases.

## Operator procedure

1. Read authenticated `GET /posts/:id/max-occurrences` (paginated with `cursor`), inspect
   REVIEW/STARTED attempts, target and receipt evidence.
2. Check the actual target channel outside this implementation. If a message exists, do not
   retry. There is no endpoint for asserting an unverified external message ID as success.
3. Stop/drain old runs and processes. If accepting the remaining duplicate risk, use the
   existing authenticated, CSRF/RBAC/policy-guarded `POST /posts/:id/retry` with:

```json
{
  "occurrenceId": "the-exact-reviewed-occurrence",
  "expectedAttempt": 1,
  "confirmation": "CHECKED_CHANNEL_AND_STOPPED_OLD_RUNS_ACCEPT_DUPLICATE_RISK"
}
```

The server records the authenticated actor and review time and grants exactly one next
attempt by CAS. Wrong org/occurrence/attempt, stale events and repeated authorization are
rejected. Lost dispatch after authorization is recovered from READY. This does not reset
other releases or delete history. Token/config/destination changes require explicit
rescheduling; manual retry cannot bypass the frozen destination check.

Without MAX-supported idempotency or authoritative reconciliation, absence of duplicates
and automatic eventual delivery cannot both be guaranteed after an ambiguous write. Manual
retry can duplicate an externally accepted message. No exactly-once claim is made.

## Proposed rollout — preparation only; not executed

1. Review all three additive migrations and take verified PostgreSQL and uploads backups.
   Record the application image and a restore procedure; image rollback cannot undo SQL.
2. Pause new scheduling and stop/drain all old backend/Inngest workers. Prevent old cached
   or unstamped MAX jobs from executing against the new deployment. Do not mix worker versions.
3. Apply the repository's guarded `prisma-migrate-deploy-safe` procedure only after separate
   deployment authorization. Never use `db push` on a shared or production database.
4. Inspect backfill/drift and operator-review records before enabling new workers. The first
   migration quarantines legacy MAX QUEUE/PUBLISHING/ERROR posts because unsent delivery cannot
   be proven. Occurrence migration preserves existing receipts/audit. The third freezes targets;
   it copies no plaintext tokens. PostgreSQL's built-in SHA-256 needs no extension.
5. Old confirmed/uncertain anchors do not guess periodic ordinals. Explicitly reschedule a
   reviewed legacy template to start a new series. Token re-encryption/reconnect may also
   invalidate the ciphertext binding and require explicit rescheduling.
6. Resume workers only after schema and configuration checks. A future live test needs a
   separately approved test bot/channel. No live MAX call is authorized by this change.

Only throwaway local PostgreSQL databases were migrated/tested. Restoring an older DB backup
can lose external delivery evidence; it is outside this guard's guarantee. Journal retention
must not delete replay evidence without an equivalent durable tombstone.
