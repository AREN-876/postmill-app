# MAX social provider — implementation brief (Postmill v1.4.0)

Status: approved for **isolated development only**. **NO deployment, live MAX API calls, channel connection, real publishing, or edits on VPS.**

## Context
- Repository: `AREN-876/postmill-app`.
- Working branch: `feat/max-provider`, originally based on **tag `v1.4.0`**. Preserve compatibility with this release. Do not rebase/upgrade to moving upstream `main` without explicit review.
- Original upstream: `postmill-ai/postmill-app`. License AGPL-3.0; retain notices.
- Existing Postmill on HOSTKEY VPS, Docker/Postgres/Redis/Inngest and Gpt2Giga are operational and must remain untouched.
- Existing StoryGo on another VPS and the production MAX channel must remain untouched. Reader Mini App and subscription checks stay in StoryGo for now.
- Editorial operation will use the **Postmill web UI**, not MAX bot commands.
- GigaChat works through the proxy directly, but **Postmill's AI agent end-to-end response is not yet verified**. Do not mix that debugging into this change.

## Primary goal (MVP)
Implement a **first-class social provider** for MAX Bot API within Postmill v1.4.0, initially without any real-world side effects. Scope:
1. Provider package `libraries/providers/max/` with manifest/metadata, `SocialAbstract` / `SocialProvider` implementation, kernel bridge and required interface methods.
2. Register in Postmill provider kernel and settings/composer UI as required by `agents/providers/overview.md` and `agents/providers/social.md`, including capability matrix, DTO, package links, path aliases, inventory, localized setup guidance and visual fallback (no external secrets).
3. Token-only connection UX like Telegram, adapted to MAX semantics. Explicit `chat_id` for a test channel; do **not** use deprecated `GET /chats` to enumerate channels. Determine a safe, documented means of supplying/obtaining `chat_id` and validating the bot's membership/rights. Never assume arbitrary `chat_id` is a valid writable channel.
4. Text-only posting adapter for `POST /messages?chat_id=...`, returning Postmill `PostResponse` with correct internal id, MAX message id, public URL when supplied, and explicit status. Validate MAX limit **4000 characters**; never silently truncate.
5. **Tests only with mock HTTP transport / recorded synthetic fixtures.** Include successful and failed credential/channel checks, text posting payload/response mapping, 401/403/429/5xx, missing chat_id, 4000-character boundary, unexpected response shape, and no token logging.
6. Document the remaining work (image uploads, three-part stories, Mini App deep links, real sandbox verification, analytics and scheduling), but do not implement speculative capabilities.

## Official API constraints
- Current host: `https://platform-api2.max.ru`. Legacy `platform-api.max.ru` is deprecated. Respect documented certificate trust requirements; **do not disable TLS verification** or add insecure exceptions.
- MAX bot token is sent in HTTP `Authorization: <token>` header, **not a URL query parameter**. Never write token to source, fixtures, logs, issue text or documentation.
- `POST /messages` supports channel post and up to 4000 characters. Includes `chat_id` query parameter for channel. Save returned `Message.body.mid` and use returned link where supported; verify actual response shape from docs before coding.
- `GET /chats` is not supported for listing joined channels; current docs say `chat_id` arrives via bot events/subscriptions/updates. Do not invent a list endpoint.
- MAX attachments require their own upload path (`POST /uploads`) when enabled later; do not simply reuse Telegram payloads.
- Use the project-standard SSRF-safe outbound transport (`this.fetch`, `safeFetch`) rather than bare `fetch`. Follow Postmill's retry/error semantics.
- Explicitly distinguish validated feature support from planned capabilities. No false `analytics`, `comments`, `video`, `carousel`, etc. flags.

Sources (verify current docs while implementing):
- https://dev.max.ru/docs-api/methods/POST/messages
- https://dev.max.ru/docs-api/methods/GET/chats
- https://dev.max.ru/docs-api/use-cases/bot-in-chats-and-channels
- https://dev.max.ru/docs-api/use-cases/sending-messages/media/
- https://github.com/postmill-ai/postmill-app/blob/v1.4.0/agents/providers/overview.md
- https://github.com/postmill-ai/postmill-app/blob/v1.4.0/agents/providers/social.md

## Development restrictions
- No access to operational MAX token, channel ids, .env or production credentials in Codex workspace. No network request to MAX during tests. Design for stubs/mocks and later isolated test credentials.
- No Docker compose changes, DB migrations, server restarts, privileged port openings, or changes to either VPS.
- Do not modify StoryGo or the existing Mini App.
- Do not enable any autonomous publishing.
- No unnecessary dependency additions or global SSRF/TLS relaxations.
- Document assumptions, failed checks, unsupported features; do not mark live connectivity as verified.

## Acceptance criteria
- `max` appears as a legitimate first-class channel in frontend composer and settings (subject to local UI testing).
- Provider package/typecheck, kernel conformance, relevant frontend tests/build pass; state clearly which were executed.
- All MAX API interactions in tests use mock transport; zero live posts.
- Token not exposed in errors or logs; invalid/missing token or chat id fails closed.
- `main` remains unmodified; commit only in the feature branch and provide diff/test summary for review.
- **Do not merge or deploy without explicit approval.**

## Later milestones (not MVP)
- Test channel with separate bot/token, real publish smoke test after explicit permission.
- Images/media and inline link/open_app button to existing reader Mini App.
- Sequence of 3 parts with scheduling, idempotency, retries and partial-failure handling.
- Content authoring and GigaChat agent validation.
- Stats collection separating organic traffic from MAX cross-promotion, ads and adjacent-post effects; statistical optimization before considering PID.

## Codex task to execute
Read this brief and the repository's existing `AGENTS.md` / provider instructions. Inspect the v1.4.0 Telegram adapter only as a reference for token-only setup (do not reuse Telegram API logic). Implement the narrow MVP in `feat/max-provider`; test with no live credentials; report remaining limitations and submit changes for code review. Never deploy.

## MVP implementation

See [MAX channel guide](user-guide/max.md) for connection, mock validation, API evidence and limitations.
