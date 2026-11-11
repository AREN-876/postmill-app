# MAX channel (text-only MVP)

MAX is a native, versioned `social/max@v1` ProviderKernel module for Postmill v1.4.0.
It is marked **Beta**: only synthetic HTTP fixtures have been tested. This implementation
has not connected a live bot/channel or sent a real message. Refs #1.

## Connection and preparation

Use Settings → Channels → MAX. Save a named credential set with a **separate test bot**
token; it is stored in the existing encrypted org credential fields. No platform environment
fallback or OAuth application is needed. Connect enables that credential set for the org's
availability gate, then asks for the exact channel `chat_id`. The existing nonce/state flow
binds the attempt to the organization and saved configuration.

Obtain `chat_id` from a `bot_added` event or a channel update in your own authorized bot
setup; there is no channel-list discovery and this MVP does not register subscriptions,
poll updates, send a `/connect` message, or publish anything during connection.

Connection reads `/me`, `/chats/{chat_id}`, and `/chats/{chat_id}/members/me`. It requires a
matching active **channel**, bot membership, and either ownership or administrator status
with the explicit `post_edit_delete_message` permission. Missing, malformed or ambiguous
rights fail closed; being able to read a chat is insufficient. Unsafe numeric ids in JSON
responses are rejected to avoid precision loss. No operational credentials are included.

The composer offers a single text post, up to **4000 UTF-16 code units** (matching the existing
Postmill counter; conservative for emoji). It disables media for text-only capabilities and
threads/comments for MAX. Unsupported payloads are also rejected server-side. There are no
MAX per-post settings, so the settings discriminator uses the standard `None`/`setEmpty`
registration instead of an unnecessary DTO class. Connection data never belongs in post settings.

## Transport and failure behavior

The adapter uses `SocialAbstract.fetch`, retaining the project's SSRF/VPN dispatcher,
timeouts and TLS verification. The host is `https://platform-api2.max.ru`. The bot token is
sent only in the `Authorization` header, never in URLs. A text fixture maps to
`POST /messages?chat_id=...&disable_link_preview=true` with `{ "text": "..." }`.
Membership and rights are rechecked before sending. The returned `message.body.mid` is the
MAX post id; the input Postmill id is preserved. The optional `message.url` is accepted only
as an HTTPS `max.ru` URL; an absent/invalid public URL remains empty rather than being invented.

401 means the static token must be replaced/reconnected; no refresh endpoint is invented.
403 means membership or posting rights must be checked. Expected connection auth/permission
rejections use the handled channel-auth path. 429 and 5xx use the existing bounded retry path
(currently up to four HTTP attempts, with shared backoff). Parse, malformed-response and
transport failures do not produce a successful post result. Upstream error bodies, request
bodies and token-echoing transport messages are discarded before an error leaves the adapter.

The inherited POST retries do **not** provide exactly-once delivery. An ambiguous response or
retry can duplicate a message: durable idempotency/reconciliation and partial-failure handling
are later work. No autonomous publishing or scheduling worker is enabled by this change.

## Validation (offline MAX API)

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run --root libraries/providers /workspace/postmill-app/libraries/providers/max/src kernel/src/__tests__/all-providers.conformance.spec.ts kernel/src/__tests__/kernel.metadata.spec.ts kernel/src/__tests__/oauth-state.guard.spec.ts --maxWorkers=2
pnpm exec vitest run --root libraries/nestjs-libraries src/integrations/org-provider-config.manager.spec.ts --maxWorkers=1
pnpm exec vitest run --root apps/frontend src/components/composer src/components/settings/channels --maxWorkers=2
pnpm exec vitest run --root apps/backend --maxWorkers=1
pnpm run build:backend
pnpm exec tsc --noEmit -p apps/frontend/tsconfig.json --incremental false
```

All MAX requests in adapter and kernel integration tests are intercepted at the shared HTTP
port and answered with synthetic fixtures. Tests cover token/channel validation, permission
revocation, payload/response mapping, unsupported features, 4000/4001 boundaries, 401/403/429/5xx,
retry recovery/exhaustion, malformed JSON/responses and token-safe errors. The kernel integration
runs registration → resolution → bridge → adapter → HTTP port, without PostgreSQL or migrations.
UI tests cover the existing settings flow, explicit chat id, nonce, credential-set enablement
and text-only composer policy. Full browser E2E and a production Next.js bundle are not claimed.

## API evidence and remaining work

The referenced `dev.max.ru` documentation pages were inaccessible under the current environment
network policy. Request/response types and routes were cross-checked against the official
[MAX TypeScript SDK](https://github.com/max-messenger/max-bot-api-client-ts/tree/81af74c50f9983d653f003bc3483ac10835071cb/src/core/network/api):
`types/{chat,message,user}.ts` and `modules/{chats,messages}/{api,types}.ts`.
This does not substitute for later, separately authorized sandbox verification.
The icon is a local monogram fallback, not an official MAX brand asset.

Not implemented: image/video uploads, attachments/buttons, three-part stories, Mini App links,
comments, analytics/watchlists, channel discovery, token refresh, MAX-specific scheduling and
idempotency. Postmill's existing scheduling facilities were not exercised. StoryGo, both VPSs,
Docker Compose, database schema/migrations and GigaChat configuration are untouched.

See [the implementation brief](../max-provider-brief.md) for the permitted scope and later milestones.
