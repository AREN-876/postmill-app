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
