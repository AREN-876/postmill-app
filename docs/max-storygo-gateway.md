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

**This draft does not support photos yet:** the Gateway contract permits
one PNG/JPEG via `POST /gateway/v1/media`, but this Postmill client
must still implement safe upload from a verified organization-owned file.
In particular, it must not download arbitrary user-supplied URLs.
Until that is completed, the provider rejects media instead of silently
omitting it.

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
Postmill's existing REVIEW state.

The Postmill missing-post sweep also reads previously STARTED/REVIEW
StoryGo receipts older than five minutes. A confirmed MID is safely
recovered by GET and committed into the existing occurrence journal.
Manual replay of an uncertain Gateway operation is blocked; explicit
rescheduling after independent operator review creates a new occurrence.
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
