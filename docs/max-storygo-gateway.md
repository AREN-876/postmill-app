# Postmill MAX-03 → StoryGo Gateway v1

Status: **opt-in integration**. Gateway activation and real MAX publishing
require explicit operator authorization.
The StoryGo server endpoint comes from merged [StoryGo PR #60](https://github.com/AREN-876/max-channel-bridge/pull/60).
This document describes the Postmill client only; no second MAX provider or
StoryGo-side publication scheduler is introduced.

## Publication types

### Automatic route selection (composer and Public API)

The MAX composer defaults to `settings.mode = "auto"` (also applies if the
mode field is omitted by n8n). A plain text scan of the normalized editor
content selects StoryGo **only** when the complete
`────────────────────────` divider appears on its own line (or when a
legacy `continuationText` field is populated). No LLM inference, image
heuristics, or automatic splitting of oversized ordinary posts. The server
persists the resulting explicit `normal`/`story` mode when creating or
scheduling a post, so the scheduled delivery path cannot change
spontaneously. Operators may override the route explicitly through the
small `Изменить` control.

**One media input for both modes:** use the standard composer attachment,
or supply a Postmill media-library `image: [{id, path}]` entry through
the API. A detected story with one image automatically moves the owned File
ID to `storyImageId` and clears the ordinary attachment list at persistence
time; native normal posts retain the attachment. StoryGo still validates
the same 8 MiB PNG/JPEG and unchanged SHA-256. Older stories with a stored
`storyImageId` remain editable without re-uploading. Conflicting old/new
photo selections and video in story mode are rejected before sending.

- **Normal** (default, including legacy posts): Postmill → MAX via the native
  MAX Bot API. Text of at most 4000 UTF-16 units, optionally with one
  ordinary media-library attachment (PNG/JPEG photo up to 16 MiB or MP4/WebM
  video up to 32 MiB in this bounded-memory implementation). The caption can
  be omitted when media is present. This is the same normal composer/API input
  n8n uses; no StoryGo reader buttons. MAX supports larger files, but this
  self-hosted adapter deliberately limits payloads until streaming uploads
  are implemented. Media is read from an organization-owned File, checked
  for size/signature, pinned by SHA-256 and rechecked before posting. A
  signed /uploads URL restricted to MAX's media upload hosts is used to send
  bytes, then POST /messages references its attachment token. No public URL
  to Postmill's private image library is needed.
- **Story**: Postmill → StoryGo Gateway → MAX. Exactly one Postmill Post
  per scheduled occurrence. The operator pastes the **entire story in the
  primary editor**, with the exact separator `────────────────────────`
  on its own line between every part. This is also the ingestion format for
  n8n or other authorized Postmill API clients: one post value containing
  the complete story and `settings.mode = "story"`. The server splits
  parts before persistence: the first part goes into `Post.content` and
  the rest into `Post.settings.continuationText`. Legacy API requests
  supplying first part + continuationText remain supported, as do edits of
  previously stored stories (the composer reconstructs one editor input).
  StoryGo still owns the reader bot and subscription gating.

Server-side validation requires 2–1000 nonempty parts; each part at most
4000 UTF-16 code units. The first nonempty title line of the public part
must be at most 160. The same TipTap-HTML-to-plain-text normalization is used for preflight
and create/update, eliminating misleading title/length failures caused by
markup. Canonical parts are then hashed in the existing Postmill occurrence
fingerprint. UTM, link shortening, tag placeholder replacement and
formatting are not applied to a story at dispatch. A missing/invalid
continuation fails validation before scheduling.

**One optional photo is supported in story mode.** Choose it using
the ordinary composer media attachment; at save the server stores
`Post.settings.storyImageId` (an org-owned File ID, not a URL). The server
re-reads the actual bytes via the org-scoped configured storage adapter
with a **streaming 8 MiB cap**, verifies detected PNG/JPEG MIME, image
structure and SHA-256, and freezes the digest in
`Post.settings.storyImageSha256`. At send time a changed/missing file
fails before MAX delivery. The photo bytes are passed ephemerally to
the MAX provider, uploaded to `POST /gateway/v1/media` immediately
before the single publication POST; the one-hour `upload_id` is not
persisted days earlier. User-supplied URLs are NEVER fetched directly.
A normal MAX post accepts one photo or video through the same composer media
attachment. The old StoryGo-only photo selector is no longer needed.

## Identity and confirmation

For each `MaxDeliveryOccurrence.id` `max_<sha256>`:

- `revision = occurrenceId` (different for every recurring release).
- `operation_id = uuidv5("postmill:max:occurrence:" + occurrenceId, UUID.NAMESPACE_URL)`.
- `external_post_id = Post.id`.
- `Idempotency-Key = operation_id`.

The client calls `beginMaxDelivery` before network I/O. The existing
`MaxDeliveryAttempt.target` records the frozen first part, all-parts
SHA-256, StoryGo UUID, original channel, integration/version, token
binding and other audit metadata. StoryGo atomically persists the
complete story before sending exactly one MAX channel message.

**Only** Gateway `PUBLISHED` plus a valid MID tied to the same
`operation_id` and `channel_id` can call `confirmMaxDelivery`.
HTTP 202/PENDING/SENDING is not publication success. A timeout after
POST triggers a read-only GET by operation_id. No automatic resend.
Missing, mismatched or inconclusive receipts are quarantined in
Postmill's existing REVIEW state. For clarity, the Postmill post detail
modal displays the saved MAX unknown-delivery marker as **Needs review**
(amber), not as a proved failed delivery (red). This is a Postmill
journal-derived status, not a fabricated real-time StoryGo `PENDING`
state. The source-of-truth MAX occurrence history remains available via
the authenticated `GET /posts/:id/max-occurrences` endpoint; StoryGo's
actual operation state is checked via its read-only GET.

The Postmill missing-post sweep also reads previously STARTED/REVIEW
StoryGo receipts older than five minutes. A confirmed MID is safely
recovered by GET and committed into the existing occurrence journal.
Manual replay of an uncertain Gateway operation is blocked; explicit
rescheduling after independent operator review creates a new occurrence.
For recurring story posts, a later occurrence remains `READY` while any
earlier unsent or unresolved revision exists; its stable identity is kept
and the existing missing-post sweep rechecks it. This prevents StoryGo's
`EXTERNAL_POST_UNRESOLVED` conflict without a second scheduler or a
false ERROR notification. Story-specific fingerprints also bind the
approval status/actor/time; unapproved or rejected stories are not sent.
MAX `stat.views` continue to come from MAX directly via Postmill.

## Deployment configuration (not set by this PR)

Required on the Postmill server, never in Git:

```text
STORYGO_GATEWAY_ENABLED=0
STORYGO_GATEWAY_BASE_URL=https://<trusted-storygo-host>
STORYGO_GATEWAY_SERVICE_KEY=<dedicated-secret-not-MAX-token>
STORYGO_GATEWAY_ALLOWED_CHANNELS=<test-channel-id>
```

Gateway POST only works with `ENABLED=1`, a dedicated secret of at least
32 characters, a plain HTTPS origin and an explicit channel allowlist.
On StoryGo the separate `STORYGO_GATEWAY_ENABLED` flag, principal token,
channel allowlist and primary-channel restrictions must also permit the
destination. Both sides remain disabled by default. Do not change
`MAX_TOKEN`, existing webhook/service secrets or Docker Compose for code review.

No live MAX POST, primary channel enablement or VPS deploy is authorized
by merging or testing this draft PR. Perform isolated mock tests first;
obtain a separate approval for one real publication in Post test later.
