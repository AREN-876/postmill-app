# MAX channel (text-only MVP)

MAX is a native, versioned `social/max@v1` ProviderKernel module for Postmill v1.4.0.
It is marked **Beta**: only synthetic HTTP fixtures have been tested. This implementation
has not connected a live bot/channel or sent a real message. Refs #4.

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
with the current `write` permission or the legacy `post_edit_delete_message` alias.
Administrator status is still required unless the bot is the owner. Missing, malformed or ambiguous
rights fail closed; being able to read a chat is insufficient. Exact signed int64 channel IDs are retained as strings, including full-width integer JSON responses, to avoid precision loss. No operational credentials are included.

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
rejections use the handled channel-auth path. Read-only GET requests retain the existing bounded
429/5xx retry path (currently up to four HTTP attempts with shared backoff). Message POST
requests explicitly set `retryPolicy: 'none'`, consumed by `SocialAbstract.fetch` before the
HTTP transport: 429, 5xx and rate-limit error bodies cannot trigger a resend. POST redirects
are also rejected. The shared defaults and retry behavior of other providers are unchanged.

Transport failures, timeouts, invalid JSON or a missing message id after POST are ambiguous:
the adapter raises a sanitized non-retriable publish error and tells the operator to check
the channel before a manual retry. It neither returns success nor automatically resends the
message, including at the workflow level. Upstream error/request bodies and token-echoing
transport messages are discarded before an error leaves the adapter.

There is no exactly-once guarantee without a MAX idempotency/reconciliation contract.
A manual retry can duplicate an accepted message; an operator must resolve ambiguous outcomes first.

## Scheduling and recovery

One-time, delayed and periodic text posts use Postmill's existing `intervalInDays` and Inngest
scheduler. Each release has its own durable PostgreSQL occurrence, attempts and receipt. A
confirmed previous release never confirms the next one. Unknown delivery blocks only that
release and requires operator review. No separate MAX scheduler is installed.

See [MAX delivery recovery](../max-delivery-recovery.md) for the authenticated manual procedure,
backup/worker/migration rollout and limits. The journal, audit and frozen target binding use
three additive migrations; none were applied to a live or shared database.

## Multiple bots and channels

Save a separate named credential set for each bot. One set can connect multiple channels; each
connection is separately selectable in the composer. The selected configuration shows its own
connected channels. New MAX identities are namespaced internally (`max:<chat_id>`), while API
requests use the exact raw ID. An existing scheduled post cannot follow changed credentials or
destinations silently: explicitly reschedule after reviewing the new target. Reconnect or token
re-encryption may require this even for the same bot.

## Validation and limits

Only synthetic upstream responses were used. Adapter/kernel, PostgreSQL, local Inngest Dev
Server and browser checks, including multiple channels, three periodic releases, process crashes,
replay, operator recovery and notification/webhook truth, are recorded in the
[MAX-02 verification report](../max-02-review.md). The frontend production bundle was checked
with explicit `--webpack`; the unchanged default build configuration has a Turbopack conflict.

Existing test entry points from the repository root:

```sh
pnpm exec vitest run --root libraries/providers
pnpm run test:int
pnpm exec vitest run --root apps/frontend src/components/settings/channels
pnpm exec vitest run --root apps/backend src/inngest/functions/post-publish.spec.ts
```

The native transport was compared with official `@maxhub/max-bot-api` 1.1.0 source/types.
This does not substitute for later, separately authorized live testing. The local icon is a
monogram fallback, not an official brand asset. New setup strings have en/ru translations and
English fallback in the other UI locales.

Not implemented: attachments, inline buttons, stories/Mini App integration, comments,
analytics/watchlists, channel discovery, token refresh or authoritative reconciliation.
StoryGo, VPSs, OpenAI models, Docker update/rollback and deployment are outside this change.
