# Editorial 13 — test-channel machine DRAFT ingress (default OFF)

This increment **only registers the existing authenticated create/read controller** when
a complete, exact test-channel configuration is present at Nest bootstrap. It does
not start Editorial Engine, install an HMAC receiver, send a review event, call MAX,
schedule posts, enable release, or make an AI/image purchase.

## Required positive runtime gate

All fields are mandatory and are checked before registering any routes:

| Variable | Contract |
| --- | --- |
| `EDITORIAL_TEST_MACHINE_ENABLED` | Exactly `true` |
| `EDITORIAL_TEST_MAX_TARGET` | Exactly `max:-73052031470103` (confirmed operator test channel) |
| `EDITORIAL_TEST_ORG_ID` | Exact existing Postmill organization ID |
| `EDITORIAL_TEST_INTEGRATION_ID` | Exact existing Postmill MAX integration ID, not a display name |
| `EDITORIAL_TEST_CAMPAIGN_ID` | Existing active campaign belonging to that organization |
| `EDITORIAL_TEST_CHANNEL_ID` | Positive Editorial Engine bigint channel ID (not a `test:...` alias) |
| `EDITORIAL_TEST_PROFILE_REF` | Immutable Editorial profile ref `...@vN` |
| `EDITORIAL_TEST_IMAGE_MODE` | Exactly `disabled` (no paid work) |
| `EDITORIAL_TEST_MACHINE_TOKEN_SHA256` | SHA-256 of the **entire** dedicated `edx_v1_<64 hex>` bearer secret |
| `EDITORIAL_TEST_MACHINE_EXPIRES_AT` | Future exact UTC millisecond timestamp `YYYY-MM-DDTHH:MM:SS.mmmZ` |

Never commit a bearer secret, a Postmill generic API token, a MAX token, or a
PostgreSQL password. The configured SHA-256 is **not** the bearer token.
Transmit the actual secret through an approved private handoff only. A
configuration missing even one field registers **zero machine routes**. A
complete configuration is necessary but does not establish production safety;
SQL checks exact org/integration/campaign eligibility and the immutable
MAX target at request time.

The token is scoped to **a single test org/integration/campaign/channel/profile**
and expires. There is no generic fallback. The controller also enforces
exact Authorization headers, raw-body JSON canonicalization and size limits.
Creation persists a native frozen DRAFT with no scheduling or dispatch authority.
An identical request is idempotent; an altered retry is a conflict.

## Activation boundary

The current VPS has 52 Prisma migrations but this route is still **OFF** until
a later explicitly approved image deployment and configuration. Before that:

- Confirm the existing MAX integration is explicitly the operator's test channel.
- An active operator test campaign is now present (created November 22, 2026).
  Its exact ID must be supplied as a trusted runtime value after verification.
  Never relabel or replace the existing Integration row or edit its MAX token.
- An independent Editorial test-channel mapping has now been created for the
  real Postmill Integration ID. Old tasks remain pinned to their old channel;
  do not reuse an old task ID as though it belonged to the new channel.
  Confirm the exact Editorial channel ID and profile at runtime.
- Keep `EDITORIAL_TEST_SESSION_ENABLED=false` and
  `EDITORIAL_TEST_RELEASE_ENABLED=false` until their separate gates are approved.
- The production all-in-one nginx config blocks
  `/api/internal/editorial/v1/drafts` and all descendant paths with a 404.
  Direct `127.0.0.1:3000` in Postmill's network namespace is the only intended
  ingress. Verify in the deployed image that the edge really denies both
  POST create and GET read; do not publish port 3000 or enable another proxy.
- Keep sender, HMAC receiver, PG bridge login role and org allowlist OFF until
  separately provisioned and reviewed. The receiver needs an unprivileged
  sidecar sharing Postmill's network namespace; Docker bridge alone is not loopback.

The final acceptance check creates **one** three-part synthetic test story
in Postmill as DRAFT, confirms no QUEUE/PUBLISHED change or MAX call, and
checks exact idempotent read. This module alone does not perform that check.
