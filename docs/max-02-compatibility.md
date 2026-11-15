# MAX-02 compatibility analysis

Issue: [#4](https://github.com/AREN-876/postmill-app/issues/4). Analysis completed before code changes.
Base: `main` at `9d1b5c49`; reference: Draft PR #2 at
`84dd76554958fdd1c8ce6a4828e38b45659a2113`; common ancestor: `a5bff720`.
The new branch starts at main. No merge/rebase of the reference branch was performed.

## Options and decision

| Option | Compatibility and operational cost |
| --- | --- |
| Merge the old branch | Would mix older registrations, schema and authorization handling with newer main; rejected. |
| Selectively adapt the native adapter and durable occurrence guard | Fits the existing kernel, encrypted named credentials, Integration and common Inngest scheduler; selected. |
| Rewrite on official `@maxhub/max-bot-api` | Version 1.1.0 supports Node >=20.19 and injectable fetch, but adds vcf/debug/form-data and separate message/polling retries. It does not resolve ambiguous accepted writes. No demonstrated benefit for three GET checks and one non-retried text POST. |

No replacement of the common architecture is required. The SDK metadata/source were inspected
without using a MAX key or endpoint; no SDK dependency was added.

## Contracts retained from current main

- ProviderKernel registration remains the only resolution path; no legacy registry or global MAX token.
- Org-scoped encrypted named credentials and per-channel Integration tokens remain authoritative.
- Main's `NotEnoughScopes.expected`, Instagram authorization handling, missing-group 404,
  newer provider registrations and OrgPortability schema are preserved.
- Shared `intervalInDays`, `post/publish`, durable steps and missing-post-finder are reused.
  Telegram/VK retain their claim, recovery, event IDs and retry defaults.
- Docker build/update/rollback files, OpenAI/Luna/Terra and StoryGo are unchanged.

## Adaptations required for multiple channels

Integration's `(organizationId, internalId)` uniqueness spans providers. New MAX identities
use `max:<exact chat_id>`; `rootInternalId` retains the raw signed int64 string. The adapter
also accepts legacy unprefixed MAX identities. Full-width numeric JSON `chat_id` values are
read from their original JSON lexeme before JavaScript can round them (Node 24 runtime).
A MAX connect cannot overwrite a conflicting other-provider Integration.

The original journal fingerprint is retained to preserve legacy receipts. A separate
server-authored `Post.maxTarget` freezes Integration ID, exact internal ID, provider version,
named configuration ID and SHA-256 of the **encrypted** token. It is written in the same
Post save as the schedule, before asynchronous journal initialization. Each claim revalidates
this binding and org/config ownership and enabled status. Attempts record the concrete
channel/config/text identity. Editing a token/config/destination cannot redirect an old
scheduled post: explicit scheduling creates a new binding and schedule revision.
A reconnect that changes ciphertext conservatively requires rescheduling even for the same bot.

Browser testing found that main's channel settings opened the first configuration sharing a
provider identifier. MAX row clicks now open the selected configuration ID, and both the row
and modal show only that configuration's connected channels. Existing provider behavior is retained.

## Evidence and rollout

See [the verification report](max-02-review.md), [occurrence design](max-occurrence-scheduling.md)
and [operator/rollout procedure](max-delivery-recovery.md). Historical PR #2 test results
are not treated as results for this branch.
