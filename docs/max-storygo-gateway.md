# Postmill MAX-03 → StoryGo Gateway v1

Status: **development PR; do not deploy or enable until reviewed.**
The StoryGo server endpoint comes from merged [StoryGo PR #60](https://github.com/AREN-876/max-channel-bridge/pull/60).
This document describes the Postmill client only; no second MAX provider or
StoryGo-side publication scheduler is introduced.

## Publication types

- **Normal** (default, including legacy posts): Postmill → MAX. One text
  message of at most 4000 UTF-16 units; current behavior unchanged.
- **Story**: Postmill → StoryGo Gateway → MAX. Exactly one Postmill Post
  per scheduled occurrence. The public part is stored in `Post.content`,
  continuation text in `Post.settings.continuationText`, mode in
  `Post.settings.mode = "story"`. The continuation textarea uses the exact
  separator `────────────────────────` alone on a line for parts 3+.
  StoryGo owns the reader bot and subscription gating.

Server-side validation requires 2–1000 nonempty parts; each part at most
4000 UTF-16 code units. The first nonempty title line of the public part
must be at most 160. Input is canonicalized from TipTap HTML to plain text
once on create/update and then hashed in the existing Postmill occurrence
fingerprint. UTM, link shortening, tag placeholder replacement and
formatting are not applied to a story at dispatch. A missing/invalid
continuation fails validation before scheduling.

**One optional photo is supported in story mode only.** Choose it using
the existing Postmill media picker in the MAX story settings, which stores
`Post.settings.storyImageId` (an org-owned File ID, not a URL). The server
re-reads the actual bytes via the org-scoped configured storage adapter
with a **streaming 8 MiB cap**, verifies detected PNG/JPEG MIME, image
structure and SHA-256, and freezes the digest in
`Post.settings.storyImageSha256`. At send time a changed/missing file
fails before MAX delivery. The photo bytes are passed ephemerally to
the MAX provider, uploaded to `POST /gateway/v1/media` immediately
before the single publication POST; the one-hour `upload_id` is not
persisted days earlier. User-supplied URLs are NEVER fetched directly.
A normal MAX post still rejects photo attachments.

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
