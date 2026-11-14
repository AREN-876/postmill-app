# MAX-02 isolated verification report

Issue [#4](https://github.com/AREN-876/postmill-app/issues/4), base main
`9d1b5c4995e65e05c26edfb10c1654597ca6846b`, reference PR #2
`84dd76554958fdd1c8ce6a4828e38b45659a2113`. New branch: `feat/max-02-multichannel`.
Executed 2026-11-14 in the Codex workspace. Main was rechecked before submission and unchanged.
No old-branch merge/rebase, live MAX API, real tokens/channels, VPS, StoryGo or deployment.

## Changes and compatibility

[Analysis and alternatives](max-02-compatibility.md) preceded implementation. The native provider,
request-local POST retry prohibition, normalized PostgreSQL journal and common Inngest workflow
were selectively adapted. No additional scheduler, SDK, service or external dependency was added. Explicit MAX rescheduling after a published release starts the new fenced generation; interrupted initialization is recovered even when older journal history exists.
Main's new providers, OrgPortability schema, Instagram authorization behavior and missing-group
404 remain intact. OpenAI/Luna/Terra and Docker/update/rollback files have no diff.

MAX-02 additions: namespaced channel identities; exact int64 JSON handling; org/config isolation;
frozen destination/config/version/encrypted-token binding in the initial Post save; explicit
rescheduling required after a destination/credential change; correct selection/display of the
second named MAX bot in settings. The last defect was reproduced through the browser on main's
identifier-based selection and fixed only for MAX; a component regression covers it.

## Automated tests (synthetic upstream only)

Commands use the existing Vitest configurations and pinned dependencies. Clean unit runs do not
inherit development feature flags or frontend/upload URL overrides.

| Command (`pnpm exec vitest run --root …`) | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `libraries/helpers` | 81 | 0 | 0 |
| `libraries/providers` (including kernel/conformance, MAX, Telegram/VK) | 3967 | 0 | 10 |
| `libraries/nestjs-libraries` | 7733 | 0 | 7 |
| `apps/backend` | 1200 | 0 | 0 |
| `apps/frontend` | 3068 | 0 | 0 |
| `apps/commands` | 22 | 0 | 0 |
| `apps/sdk` | 15 | 0 | 0 |
| `apps/extension` | 8 | 0 | 0 |
| **Total** | **16094** | **0** | **17** |

The package totals include two final MAX reschedule service regressions run with the affected 98-test set after the full package runs. The final 38-test PostgreSQL run also covers a reschedule committed before initial journal creation despite confirmed old history.

The focused MAX provider/kernel selection also passed 112 tests; backend workflow 27;
channel frontend 25; IntegrationManager 68. These overlap the package totals, not extra tests.
The full sweep first exposed seven failures: six caused by inherited dev flags/URL overrides,
and missing MAX translation keys in other locales. MAX keys now exist in all UI locales (English
fallback outside en/ru); clean runs passed. No AI source or model settings were changed.

`pnpm run test:int`: **38 passed, 0 failed** in 7 files (32 MAX tests plus 6 existing PostgreSQL integration tests). The MAX suite executes all three exact migration SQL files, verifies legacy receipt/review backfill and runs Prisma migrate diff with `--exit-code` against the final schema. It covers claims/replays/concurrent jobs, multiple channels/configs/orgs, target changes, missing initial journal, three releases and Telegram/VK recovery. The destructive-schema guard also passed. The migration diff test uses workspace-pinned `pnpm exec prisma`, with no dlx download needed.

| Build/check | Result |
| --- | --- |
| Frozen dependency install; Prisma Client generate | Passed; no manifest version changes or external dependency added. |
| `pnpm run build:backend` | Passed, including TypeScript compilation. Initial local stale Sentry modules were repaired by frozen install, without Sentry source changes. |
| `pnpm exec tsc -p apps/frontend/tsconfig.json --noEmit` | Passed. |
| `NODE_ENV=production pnpm --filter ./apps/frontend exec next build --webpack` | Passed (bundle, TypeScript and static generation). |
| Default `pnpm run build:frontend` | Existing main configuration fails: Next 16 selects Turbopack while next.config defines webpack. Explicit --webpack works; unchanged build/Docker config is outside Issue #4. |
| `pnpm run openapi:generate` | Passed: 514 paths, 245 schemas; 43 generated added lines. Cron dev-flag logging was disabled for the generator's JSON stdout. |
| `pnpm exec eslint . --report-unused-disable-directives` | 0 errors, 279 repository warnings; focused final MAX/new UI checks have 0 errors/warnings. |
| `git diff --check` | Passed. |

Coverage runs passed for all six roots in `test:coverage`, with unchanged thresholds:

| Root | Statements | Branches | Functions | Lines |
| --- | ---: | ---: | ---: | ---: |
| helpers | 62.75% | 56.52% | 68.18% | 63.12% |
| providers | 83.51% | 76.20% | 84.89% | 87.19% |
| nestjs-libraries | 76.74% | 68.30% | 77.51% | 78.50% |
| backend | 85.55% | 62.93% | 86.55% | 85.85% |
| frontend | 88.59% | 80.80% | 80.38% | 90.40% |
| commands | 83.44% | 70.66% | 84.90% | 87.56% |

Commands: `pnpm exec vitest run --root <root> --coverage` for each row. Final reschedule guards were then checked in the affected unit/PostgreSQL suites; those repository/service files are outside the configured coverage include surface.

## Real local integration boundaries

Local backend and frontend, a dedicated `max02_validation` PostgreSQL database, Redis and
Inngest Dev Server **1.52.0** were used. Chromium/Playwright drove the real UI and authenticated
HTTP APIs. Backend undici calls to the canonical MAX host were intercepted in-process; every
other MAX URL was blocked. The mock webhook URL was intercepted too. Only synthetic bot keys
`fixture-bot-A/B` were supplied; no network MAX endpoint was contacted.

| Scenario | Observed evidence |
| --- | --- |
| Settings connect A to -101 and -102; B to -103 | Three distinct Integrations, correct providerConfigId; B panel excludes A channels; connection GETs only. |
| Composer changes selected channel for a new post | Browser saved A draft and published B text; DB integration IDs and mock bot/channel pairs match. |
| Secrets at rest | Integration tokens are v2 ciphertext; HTTP connection response omits token. |
| Delayed text post, fractional deadline | One confirmed receipt after the rounded absolute deadline, no early not-before rejection. |
| Three periodic releases | Three distinct CONFIRMED occurrence rows/receipts, next READY child; exactly three matching mock POSTs. |
| Replay and simultaneous independent dispatch | No additional POST for a confirmed or uncertain occurrence; PostgreSQL tests exercise concurrent claims directly. |
| Ambiguous timeout after accepting POST | REVIEW, no automatic resend, no successful notification/webhook. |
| SIGKILL after mock acceptance before receipt persistence | One POST only across backend restart/replay; stale attempt moves to REVIEW. |
| Unsent scheduled work across restart | One POST and CONFIRMED receipt after restart. |
| QUEUE commit with missing initial journal | Invoking the actual missing-post-finder in Dev Server creates and publishes one intent. |
| Published-template explicit reschedule | HTTP date scheduling starts a new fenced generation; an interrupted reschedule with older confirmed history is recovered by the actual missing-post-finder. |
| Controlled manual recovery | Empty confirmation rejected; exact occurrence/attempt/confirmation grants attempt 2, audit actor retained and receipt confirmed. |
| Notification/webhook truth | Every captured published webhook resolves to a CONFIRMED occurrence; crash/uncertain post has no success notification. |

The three-release catch-up fixture was created through the API as a draft (including frozen
binding), then given an overdue date in the isolated DB and emitted through the common workflow.
This avoids waiting two days and does not add a MAX scheduler. The hourly recovery function was
invoked through Dev Server GraphQL; the cron clock itself was not waited out. A stale timestamp
was advanced locally for the three-hour crash quarantine check.

Inngest investigation: normal MAX repeat transport IDs are `max_occurrence_<persisted child ID>`;
step dispatch is memoized, while PostgreSQL identity is authoritative across distinct runs and
beyond dedup retention. Sending two local transport events with external ID `max02-fixed-dedup-id`
returned two ingestion IDs, but GraphQL showed **one** completed function run in total. Distinct
transport IDs replaying the same occurrence also produced no second MAX POST. Production event
retention/TTL and managed Inngest service behavior were not measured.

Workspace evidence: `/tmp/max02-review/` contains suite/build logs, browser scripts/screenshots,
mock request/post/webhook traces, `runtime-state.json`, `recovery-proof.json` and `dedup-runs.json`.
These are local artifacts, not committed credentials or production data. PostgreSQL tests and
browser component regressions are committed; the manual stack harness is not a new product service.

## Security, remaining limits and rollout

- Native transport retains the fixed HTTPS host, token-only Authorization header, existing
  SSRF/VPN dispatcher and TLS validation. Token-echo, redirect, rights, 401/403, 429/5xx and
  ambiguous-body/timeout fixtures are covered. No token is placed in a URL, event or attempt.
- Frozen encrypted-token hashes are not usable credentials. Reconnect/re-encryption changes
  ciphertext and conservatively blocks old work until explicit rescheduling.
- No live MAX compatibility claim: permission/response fixtures still require a separately
  approved test bot/channel. Text only, <=4000 UTF-16 units; no media, threads or comments.
- No authoritative reconciliation API, no automatic success assertion, no exactly-once promise.
  Manual retry after an uncertain write can duplicate a real message. Notification/webhook
  delivery is itself at-least-once; downstream consumers should deduplicate by occurrence ID.
- Journal history is retained without automatic compaction. Initial recovery scans uninitialized
  due MAX QUEUE roots, idempotently checking the current schedule generation even when older history exists; very large queues/history require later measured optimization, not this task.
- Database backup rollback can erase delivery evidence. All old workers/jobs must be stopped
  before any approved migration rollout. See [the explicit backup/worker/migration procedure](max-delivery-recovery.md).
- New MAX connections use namespaced identities. Legacy unprefixed connections remain usable;
  reconnecting them can create a distinct namespaced Integration. Review legacy schedules rather
  than silently migrating their destination identity.
- New MAX UI strings use English fallback in locales other than en/ru; native translations are
  not claimed. No unrelated editorial or AI settings were changed.

## Changed files

79 files. The branch diff is authoritative (`git diff --name-only 9d1b5c49...HEAD`).

- `agents/jobs.md`
- `agents/providers/social.md`
- `apps/backend/package.json`
- `apps/backend/src/api/routes/posts.controller.ts`
- `apps/backend/src/inngest/functions/post-publish.spec.ts`
- `apps/backend/src/inngest/functions/post-publish.ts`
- `apps/backend/src/providers.generated.ts`
- `apps/frontend/public/icons/platforms/max.png`
- `apps/frontend/src/components/composer/editor.tsx`
- `apps/frontend/src/components/composer/media-capabilities.ts`
- `apps/frontend/src/components/composer/providers/max/max.provider.tsx`
- `apps/frontend/src/components/composer/providers/show.all.providers.tsx`
- `apps/frontend/src/components/launches/web3/providers/max.provider.tsx`
- `apps/frontend/src/components/launches/web3/web3.list.tsx`
- `apps/frontend/src/components/settings/channels/channel-edit.modal.spec.tsx`
- `apps/frontend/src/components/settings/channels/channel-edit.modal.tsx`
- `apps/frontend/src/components/settings/channels/channels.tab.spec.tsx`
- `apps/frontend/src/components/settings/channels/channels.tab.tsx`
- `apps/frontend/src/components/settings/channels/max-composer.spec.tsx`
- `docs/max-02-compatibility.md`
- `docs/max-02-review.md`
- `docs/max-delivery-recovery.md`
- `docs/max-occurrence-scheduling.md`
- `docs/max-provider-brief.md`
- `docs/user-guide/max.md`
- `libraries/nestjs-libraries/src/database/prisma/integrations/integration.repository.ts`
- `libraries/nestjs-libraries/src/database/prisma/migrations/20261112080000_max_delivery_guard/migration.sql`
- `libraries/nestjs-libraries/src/database/prisma/migrations/20261112100000_max_occurrences/migration.sql`
- `libraries/nestjs-libraries/src/database/prisma/migrations/20261114090000_max_target_binding/migration.sql`
- `libraries/nestjs-libraries/src/database/prisma/posts/max-delivery.int-spec.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/max-occurrences.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/max-target.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.spec.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/schema.prisma`
- `libraries/nestjs-libraries/src/dtos/posts/providers-settings/all.providers.settings.ts`
- `libraries/nestjs-libraries/src/dtos/posts/retry.post.dto.ts`
- `libraries/nestjs-libraries/src/inngest/activities/post.activity.spec.ts`
- `libraries/nestjs-libraries/src/inngest/activities/post.activity.ts`
- `libraries/nestjs-libraries/src/inngest/inngest.types.ts`
- `libraries/nestjs-libraries/src/integrations/integration.manager.spec.ts`
- `libraries/nestjs-libraries/src/integrations/integration.manager.ts`
- `libraries/nestjs-libraries/src/integrations/org-provider-config.manager.spec.ts`
- `libraries/nestjs-libraries/src/integrations/org-provider-config.manager.ts`
- `libraries/providers/PROVIDERS_INVENTORY.md`
- `libraries/providers/kernel/src/domains/social-base.spec.ts`
- `libraries/providers/kernel/src/domains/social-base.ts`
- `libraries/providers/kernel/src/domains/social-capabilities.ts`
- `libraries/providers/kernel/src/verification.ts`
- `libraries/providers/max/package.json`
- `libraries/providers/max/src/index.ts`
- `libraries/providers/max/src/v1/__tests__/fixtures.ts`
- `libraries/providers/max/src/v1/__tests__/max.int-spec.ts`
- `libraries/providers/max/src/v1/__tests__/review-regressions.spec.ts`
- `libraries/providers/max/src/v1/__tests__/social.adapter.spec.ts`
- `libraries/providers/max/src/v1/__tests__/transport.ts`
- `libraries/providers/max/src/v1/index.ts`
- `libraries/providers/max/src/v1/metadata.ts`
- `libraries/providers/max/src/v1/social.adapter.ts`
- `libraries/react-shared-libraries/src/translation/locales/ar/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/de/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/en/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/es/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/fr/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/id/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/it/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/ja/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/ko/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/nl/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/pl/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/pt/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/ru/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/tr/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/vi/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/zh/translation.json`
- `openapi.yml`
- `pnpm-lock.yaml`
- `tsconfig.base.json`
