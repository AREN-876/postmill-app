> Latest PR #2 implementation: [occurrence-aware periodic scheduling](max-occurrence-scheduling.md). Historical per-Post results below are superseded by the final section.

# MAX MVP review — Issue #1

Base: `feat/max-provider` at `9906d34c` (v1.4.0 plus approved brief).
Implementation branch: `feat/max-provider-mvp`. No merge/rebase onto main.

## Result

Native `social/max@v1`, explicit channel id and bot token, read-only connection checks,
text-only composer, 4000-character validation, sanitized API errors, mocked transport tests.
Detailed behavior, source evidence and limitations: [MAX channel guide](user-guide/max.md).
No schema changes, migrations, Docker/VPS/StoryGo edits, real MAX calls or publication.

## Validation

| Check | Passed | Failed |
| --- | ---: | ---: |
| Selected provider + kernel conformance/metadata/OAuth-state suites | 1831 | 0 |
| Of the above: MAX unit and mocked kernel integration | 59 | 0 |
| Backend regression (v1.4.0 base) | 1153 | 0 |
| Composer + channel settings frontend regression | 120 | 0 |
| Org credential manager | 11 | 0 |

The selected provider run also includes the existing Minimax tests due to Vitest's substring
filter matching. MAX tests are 58 unit cases + one mocked kernel integration case, not 1831
MAX API scenarios. The prior 1191 backend total belonged to the newer main checkout;
the requested v1.4.0 base has 1153 tests. No tests were skipped in the selected runs.

Also passed: frozen-lockfile installation, backend build, frontend TypeScript check,
ESLint over changed TypeScript/TSX files, and `git diff --check`.
Not run/claimed: a production Next.js bundle, browser E2E, live MAX sandbox, database
integration/migrations, deployments or restored-environment validation.

## Reviewer focus

- All provider traffic uses the shared safe transport and the current API host.
- No bot token in URL, upstream body, transport exception, stored error body or log.
- Channel must be active, match the exact id, and grant the bot explicit posting rights.
- Nonempty state verifier and named org credentials survive the existing connect flow.
- Text-only capability gates the UI and server; non-text payloads fail before HTTP.
- Beta status is intentional. MAX POST uses a request-local no-retry policy; ambiguous
  delivery requires operator reconciliation before a manual retry. Exactly-once delivery
  is outside this MVP.
- No custom per-post DTO fields: standard None/setEmpty discriminator registration.

## Changed files

- `apps/backend/package.json`
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
- `apps/frontend/src/components/settings/channels/max-composer.spec.tsx`
- `docs/max-provider-brief.md`
- `docs/max-provider-review.md`
- `docs/user-guide/max.md`
- `libraries/nestjs-libraries/src/dtos/posts/providers-settings/all.providers.settings.ts`
- `libraries/nestjs-libraries/src/integrations/org-provider-config.manager.spec.ts`
- `libraries/nestjs-libraries/src/integrations/org-provider-config.manager.ts`
- `libraries/providers/PROVIDERS_INVENTORY.md`
- `libraries/providers/kernel/src/domains/social-capabilities.ts`
- `libraries/providers/kernel/src/verification.ts`
- `libraries/providers/max/package.json`
- `libraries/providers/max/src/index.ts`
- `libraries/providers/max/src/v1/__tests__/fixtures.ts`
- `libraries/providers/max/src/v1/__tests__/max.int-spec.ts`
- `libraries/providers/max/src/v1/__tests__/social.adapter.spec.ts`
- `libraries/providers/max/src/v1/__tests__/transport.ts`
- `libraries/providers/max/src/v1/index.ts`
- `libraries/providers/max/src/v1/metadata.ts`
- `libraries/providers/max/src/v1/social.adapter.ts`
- `libraries/react-shared-libraries/src/translation/locales/en/translation.json`
- `libraries/react-shared-libraries/src/translation/locales/ru/translation.json`
- `pnpm-lock.yaml`
- `tsconfig.base.json`

## PR #2 review corrections (2026-11-12)

Review was read from the PR conversation page (GitHub API returned Forbidden).
Both requested corrections are implemented in the existing `feat/max-provider-mvp` branch:

- Accept `write` and legacy `post_edit_delete_message` for an administrator, preserving
  ownership and identity checks and failing closed for all other permissions/non-admins.
- Add a request-local `retryPolicy: 'none'` opt-out to SocialAbstract. MAX uses it for
  message POSTs only, and rejects POST redirects. The HTTP port never receives this
  internal policy option. Shared default retries and MAX read-only GET retries remain intact.
- Ambiguous POST outcomes (429/5xx, timeout, connection reset, invalid JSON or missing mid)
  produce a sanitized non-retriable publish error, with guidance to inspect the channel
  before any manual retry. Durable idempotency/reconciliation remains out of scope.

Regression tests were executed against the old implementation first: **7 failed, 11 passed**,
reproducing the modern permission and unsafe POST retry defects. After the fix:

| Check | Passed | Failed |
| --- | ---: | ---: |
| Provider/kernel selection, including shared fetch and conformance | 1861 | 0 |
| Of the above: MAX unit/mock integration/review regression cases | 78 | 0 |
| Of the above: shared fetch cases | 11 | 0 |
| Backend regression | 1153 | 0 |

The provider selection also runs the existing 22 Minimax cases due to substring matching.
No tests skipped. Backend build, changed-file ESLint and diff whitespace checks passed.
No frontend source changed in this correction; UI/browser checks were not repeated.
No live MAX requests, real tokens, channel connections, merge or deployment occurred.

Files changed for this review iteration:

- `libraries/providers/max/src/v1/social.adapter.ts`
- `libraries/providers/max/src/v1/__tests__/review-regressions.spec.ts`
- `libraries/providers/max/src/v1/__tests__/social.adapter.spec.ts`
- `libraries/providers/max/src/v1/__tests__/max.int-spec.ts`
- `libraries/providers/kernel/src/domains/social-base.ts`
- `libraries/providers/kernel/src/domains/social-base.spec.ts`
- `agents/providers/social.md`
- `docs/user-guide/max.md`
- `docs/max-provider-review.md`

## MAX crash-recovery follow-up (2026-11-12)

This follow-up supersedes the original MVP's no-schema-change limitation. It adds one
nullable `Post.maxDelivery` JSONB column and an additive migration, tested only on an
isolated local PostgreSQL database. No migration was applied to the shared development DB,
VPS or production. No merge/deployment occurred.

Design comparison, all failure boundaries, rollout precautions, operator confirmation API,
and remaining risks: [MAX delivery recovery contract](max-delivery-recovery.md).

Latest verification:

| Check | Passed | Failed |
| --- | ---: | ---: |
| Real PostgreSQL migration/recovery/activity integration | 12 | 0 |
| Affected posts/activity unit suites | 93 | 0 |
| Backend regression | 1153 | 0 |
| Provider/kernel selection | 1861 | 0 |

Also passed: Prisma Client generation, backend build, frontend TypeScript check,
changed-file ESLint, additive migration destructive guard, OpenAPI generation/drift check
and whitespace checks.
The tests simulate process-loss boundaries through injected failures and fresh activity
calls against the durable database. They do not kill an Inngest cloud worker or contact
MAX. The provider selection still includes 22 existing Minimax cases due to substring
filter matching. Full UI/browser E2E and deployment were not performed.

The manual retry is an authenticated API operation with an explicit attempt-bound
acknowledgement, not a new UI dialog. Existing retry clicks cannot authorize a STARTED
attempt. A known published message should not be retried; operator-supplied-mid finalization
is not implemented in this change. Automatic eventual delivery and exactly-once are not
claimed. Old workers must be quiesced for a future rollout and before authorizing a retry.

Changed implementation files:

- `libraries/nestjs-libraries/src/database/prisma/schema.prisma`
- `libraries/nestjs-libraries/src/database/prisma/migrations/20261112080000_max_delivery_guard/migration.sql`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.spec.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/max-delivery.int-spec.ts`
- `libraries/nestjs-libraries/src/inngest/activities/post.activity.ts`
- `libraries/nestjs-libraries/src/dtos/posts/retry.post.dto.ts`
- `apps/backend/src/api/routes/posts.controller.ts`

Documentation: `agents/jobs.md`, `docs/user-guide/max.md`, this report, and
`docs/max-delivery-recovery.md`.

The generated `openapi.yml` documents the optional retry request body; existing providers
can keep retrying without a body. The generator used a separate empty local database,
which was removed after generation.

## Periodic occurrence implementation (2026-11-12)

The accepted direction uses the common intervalInDays / post-publish / Inngest infrastructure.
A normalized occurrence/attempt journal replaces the post-wide delivery gate. Each successor
has a stable distinct ID and due date; replays preserve that identity. Normal repeat event IDs
are stable per occurrence, while recovery can redispatch the same occurrence with a fresh
transport event ID. The expected attempt generation also fences stale pre-authorization jobs.

Two additive tables and a defaulted schedule revision preserve independent receipts and
operator audit without a growing Post JSON map. The migration keeps old receipts/history as
immutable legacy anchors. Legacy anchors do not guess periodic ordinals or emit new success;
explicitly reschedule old templates with a future date to start the new periodic chain.
No migration was applied to a shared dev DB, VPS or production.

Final checks:

| Check | Passed | Failed |
| --- | ---: | ---: |
| Real PostgreSQL migration/schema-drift/occurrence tests | 22 | 0 |
| Affected posts and activity unit tests | 94 | 0 |
| Backend, including 26 workflow cases | 1161 | 0 |
| Selected provider/kernel suites | 1861 | 0 |

Also passed: Prisma generation, backend build, frontend TypeScript check, changed-file ESLint,
additive migration guard, exact SQL migration vs Prisma schema diff, OpenAPI generation/drift
check and git whitespace check. Provider selection includes the existing 22 Minimax cases
because of substring filtering. No tests skipped in these selected runs.

PostgreSQL scenarios cover three sequential deliveries with distinct mids, replay, acceptance
before failed receipt persistence, lost commit acknowledgement, concurrent activities,
independent progress after an uncertain occurrence, operator retry and stale attempt fencing,
channel/text/date/interval edits, pause/resume, late receipt after cancellation, 25 successor
plans, legacy migration and Telegram/VK recovery. Workflow cases verify stable/distinct event
IDs and absence of new success notifications/webhooks for unknown, duplicate, cancelled and
legacy unstamped events. MAX webhooks use the confirmed attempt's actual content snapshot.

Limits and rollout contract are detailed in the linked design. No real MAX requests/tokens,
cloud Inngest execution, browser E2E, VPS/StoryGo changes, merge or deployment. API-only
operator retry/review remains; unverified-mid reconciliation is not added. Unknown delivery
is not automatically retried. Missed distinct slots may catch up and create a backlog.
History guards must not be pruned without tombstones. A future rollout must drain old workers;
exactly-once is not claimed. PR #2 remains a Draft review change.

Changed files for this iteration:

- `agents/jobs.md`
- `apps/backend/src/api/routes/posts.controller.ts`
- `apps/backend/src/inngest/functions/post-publish.spec.ts`
- `apps/backend/src/inngest/functions/post-publish.ts`
- `docs/max-delivery-recovery.md`
- `docs/max-occurrence-scheduling.md`
- `docs/max-provider-review.md`
- `docs/user-guide/max.md`
- `libraries/nestjs-libraries/src/database/prisma/migrations/20261112100000_max_occurrences/migration.sql`
- `libraries/nestjs-libraries/src/database/prisma/posts/max-delivery.int-spec.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/max-occurrences.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.spec.ts`
- `libraries/nestjs-libraries/src/database/prisma/posts/posts.service.ts`
- `libraries/nestjs-libraries/src/database/prisma/schema.prisma`
- `libraries/nestjs-libraries/src/dtos/posts/retry.post.dto.ts`
- `libraries/nestjs-libraries/src/inngest/activities/post.activity.spec.ts`
- `libraries/nestjs-libraries/src/inngest/activities/post.activity.ts`
- `libraries/nestjs-libraries/src/inngest/inngest.types.ts`
- `openapi.yml`
