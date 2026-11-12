# MAX MVP: isolated integration review (2026-11-12)

PR #2 / `feat/max-provider-mvp`, baseline `a38291c0`.

**Baseline: NO-GO. After the two minimal fixes in this review: GO for a separately
controlled test-channel trial.** This is not approval for production rollout or
an exactly-once delivery guarantee. PR remains Draft.

## Environment and scope

Real Next.js frontend (Chromium), compiled NestJS backend, dedicated PostgreSQL
`max_final_validation`, existing local Redis, and Inngest Dev Server v1.52.0.
MAX requests were intercepted in the backend's HTTP transport with synthetic bot,
channel and message responses. Unexpected MAX paths/hosts were blocked; browser
MAX navigation was also blocked. No MAX credentials or live channel were used.
Webhook transport and its DNS answer were synthetic; production SSRF/TLS code was
unchanged. Setup completion and the local account were fixture data, without an
LLM key. For split-origin cookie auth, frontend/backend used credential-enabled
CORS rather than the `NOT_SECURED` development shortcut.

Existing tests and application interfaces were used. Temporary orchestration,
transport fixtures and logs lived under `/tmp/max-final`, outside the repository.
No features, migrations, deployment, VPS/StoryGo changes or merges were made.

## Blocking defects reproduced and fixed

1. **Early scheduler wake-up.** A release due at `07:09:21.706Z` woke before its
   PostgreSQL not-before guard, produced no POST and stayed READY. The relative
   Inngest duration truncates fractional seconds; an exact absolute timestamp
   alone also reproduced an early wake-up in this Dev Server. MAX now uses
   `sleepUntil` with its absolute deadline rounded up to a whole second. Ordinary
   providers are unchanged. A regression test emulates whole-second resolution.
   A subsequent real run due at `07:20:23.763Z` sent at `07:20:24.327Z` and confirmed.
2. **Crash before journal initialization.** Killing the backend immediately after
   the create-post response left a QUEUE root with no occurrence: post commit
   precedes asynchronous `startWorkflow`. The MAX recovery scan previously only
   knew journal rows. Recovery now initializes due MAX QUEUE roots with no
   occurrence under the existing parent lock, retaining legacy delivery guards.
   Parallel PostgreSQL sweeps and activities produced one occurrence/attempt/send.
   The actual `missing-post-finder` function was then invoked in the local Dev
   Server: the orphan was recovered and confirmed once (`offline-12`).

## Checks actually performed

| Boundary/scenario | Observed result |
|---|---|
| Connection | Synthetic token config, nonce mint and `/integrations/social-connect/max` completed through backend. Browser saved a token config, entered explicit chat_id and completed **Validate test channel**; no message was sent by connection. |
| Editor and persistence | MAX available in channel settings and composer; browser saved a text draft through real API validation/PostgreSQL and submitted **Post now** through the real workflow. |
| Scheduled release | Fractional-second deadline respected after fix; one POST, confirmed receipt and PUBLISHED state. |
| Three periodic releases | Real shared Inngest chain, intervalInDays=1; three CONFIRMED occurrences with distinct `offline-16`, `offline-17`, `offline-18` receipts. Future releases remained READY without sending. Due dates were seeded in the past to test catch-up without waiting three days; no alternate scheduler was added. |
| Process killed after acceptance | Fixture logged one accepted POST, then SIGKILL before returning mid. PostgreSQL retained STARTED/attempt 1/no receipt. Restart/replay sent no second POST. Aging the row exercised the existing three-hour recovery transition to REVIEW. |
| Ambiguous timeout | One fixture POST followed by transport failure led to REVIEW/ERROR; no success notification/webhook. |
| Manual recovery | Authenticated journal endpoint exposed occurrence/attempt history. Retry without confirmation returned 400. Explicit confirmation authorized attempt 2, which confirmed with a receipt; attempt 1 retained RETRY_AUTHORIZED, actor and review time. This intentionally accepts duplicate risk. |
| Parallel/repeated jobs | Eight different Inngest event IDs targeting one occurrence produced one POST. Confirmed/uncertain replay produced no new POST or success side effects. |
| Success side effects | A replay checkpoint held counts at 18 fixture POSTs, 16 success notifications and 12 recorded success webhooks, before and after replay. Failed/unknown acceptance had no success receipt/hook. Each captured success hook referred to a confirmed occurrence. |
| Telegram/VK | Existing real PostgreSQL claim/recovery/activity cases passed unchanged. Their API delivery was not live-tested. |

The Dev Server accepted duplicate external event IDs into separate internal event
records; event acceptance/returned IDs alone must not be interpreted as a delivery
deduplication guarantee. PostgreSQL guards prevented repeat sends independently.

## Targeted automated verification

- Publishing workflow: **27 passed** (includes timer regression).
- Real PostgreSQL MAX integration: **24 passed** (includes two new initialization
  recovery regressions, exact migration SQL/drift checks, parallelism and Telegram/VK).
- Affected posts repository/service/activity: **94 passed**.
- MAX composer: **1 passed**.
- **146 passed, 0 failed** in the final targeted runs. Earlier failing reproductions
  were resolved; broad backend/provider suites were not repeated.
- Backend build/type checking, targeted ESLint and `git diff --check`: passed.

## Reproduction and repeat commands

For the timer reproduction, schedule a MAX fixture post about 20 seconds ahead
with a non-zero millisecond component. Run the real local Dev Server and inspect
the journal immediately after wake-up. Before the fix the not-before claim can
reject an early wake with READY/attempt 0 and no POST; after the fix the accepted
POST timestamp must be at or after scheduledAt.

For the initialization gap, SIGKILL the isolated backend immediately after the
POST /posts response, before startWorkflow persists an occurrence. Check QUEUE,
zero occurrences and zero fixture sends. Restart, wait past publishDate and invoke
`missing-post-finder` in the Dev Server. Before the fix it misses the post; after
the fix it creates one occurrence and confirms one attempt. The new PostgreSQL
regression seeds this exact persisted state without process timing dependence.

Run from the repository with the existing local test database/cache setup:

```bash
pnpm exec vitest run --root apps/backend src/inngest/functions/post-publish.spec.ts
pnpm exec vitest run --root libraries/nestjs-libraries --config vitest-integration.config.ts max-delivery.int-spec.ts
pnpm exec vitest run --root libraries/nestjs-libraries src/database/prisma/posts/posts.repository.spec.ts src/database/prisma/posts/posts.service.spec.ts src/inngest/activities/post.activity.spec.ts
pnpm exec vitest run --root apps/frontend src/components/settings/channels/max-composer.spec.tsx
pnpm run build:backend
```

## Limits

- Synthetic responses do not establish real MAX token scopes, API compatibility,
  quotas, network behavior or permissions on a test channel. Those need a separate
  authorized trial.
- SIGKILL covered the acceptance/receipt gap; the three-hour stale threshold was
  exercised by aging isolated database timestamps. Three-day recurrence was
  exercised with seeded overdue dates, not a multi-day soak.
- Hourly recovery can delay a lost job until its next sweep. Success notification
  and webhook delivery themselves are not exactly-once; a lost step acknowledgement
  may omit or repeat a side effect. The receipt journal remains authoritative.
- Automatic delivery plus no duplicates cannot both be guaranteed after ambiguous
  MAX acceptance without MAX idempotency/reconciliation support. REVIEW requires
  operator investigation; explicitly authorized retry may duplicate a message.
