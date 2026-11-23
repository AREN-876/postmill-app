# Editorial pre-review text installation (test-only)

## Why

An initial test-only Postmill DRAFT may have been created before the four-stage Editorial Engine Editor output existed. The initial immutable admission receipt still contains the test seed and does **not** match the final Editorial-013 text revision 1. Do not overwrite the receipt, spoof a remote review, use direct SQL `UPDATE`, or publish the seed.

## Contract

`POST /internal/editorial/v1/drafts/:taskId/install-text` accepts the **same exact compact JSON** as initial machine draft creation, but with Editor's final `{title,parts}` and its actual PostgreSQL `jsonb::text` SHA-256. The path task ID must exactly match the body. Only the dedicated, unexpired, test-org/channel bearer is accepted. Transport is private to the Nest backend; the public nginx API blocks this path. No generic API key or cookie access.

SQL `postmill_install_editorial_text_v1` validates the immutable original scope, current MAX target identity, native DRAFT and absence of children, anchor, decisions and release. It accepts one **different** revision-1 artifact, changes only `Post.content` and `Post.settings.continuationText` in one transaction, and stores the immutable `EditorialTextInstall` record with the original SHA-256 and replacement prepared envelope. The first admission receipt is **never modified**. Identical install replay returns `installed:false`; changed replay conflicts. The original create POST is no longer a valid replay after installation; reconcile by GET.

Machine GET, human review read and later release must revalidate **the installed** content/hash. The original 06A fence remains for all unrelated changes and every native editor mutation. No automatic Editorial acknowledgement, approval, posting, model dispatch or image generation is added.

## Prerequisites for a live test

1. CI with full Prisma migration + SQL/HTTP regressions must pass; review and back up the target DB. Do not replace the pinned production image or install the migration independently.
2. Read task #6's completed `core.text_stages` stage `edit`, assert `core.text_runs.status='ready_for_review'`, and independently compare its JSON `{title,parts}` SHA-256 against the intended machine request. This terminal state is format-valid, **not factual approval**.
3. Test org/channel binding and strict loopback machine token are unchanged. The sender must not overwrite or approve any other task. Missing/ambiguous HTTP outcome: use authenticated GET and the installation ledger; never blindly submit a different payload or issue another AI request.
4. After install, compare Editorial Engine's revision-1 hash, machine GET receipt, `Post.content`, `Post.settings.continuationText`, human read content and browser rendering. The text/first-part/continuation must match exactly. The browser must show **DRAFT**, no native approval/schedule and no publication before signed Editorial approval and a separate release command.
5. Only after those checks should the trusted operator call `core.start_review` and anchor the authentic resulting remote state. A changed/mismatched SHA-256 is a stop condition, not a reason to relax a guard.

## Negative tests

Wrong machine bearer, org/target/task, digest, compact-body encoding, duplicate keys, missing source receipt, altered native DRAFT, changed MAX target, pre-existing review/decision/release, conflicting second install, native edit, deletion and scheduling must fail without modifying the story or granting publication. All ordinary posts retain native behavior.

**Rollout remains blocked until reviewed CI and browser verification.** Do not run this migration or promote an image based only on a successful API unit test.
