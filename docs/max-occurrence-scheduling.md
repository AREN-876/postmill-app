# MAX periodic occurrences — Postmill v1.4.0

Adapted from PR #2 for [MAX-02 / Issue #4](max-02-compatibility.md).

This supersedes the per-Post journal described in the earlier recovery implementation.
It uses the existing `intervalInDays`, `post/publish` Inngest function, `step.sleepUntil`, repeat
event payload and hourly missing-post-finder. No additional scheduler/cron/queue is registered.
Telegram/VK keep their existing event IDs, claim path and scheduling behavior.

## Design comparison

A single CONFIRMED marker cannot distinguish a new release from replay. Clearing it before
a repeat reopens the crash window. An ever-growing occurrence map inside Post JSON would
serialize unrelated histories into one large value and make audit/retention difficult.

The chosen journal has two normalized tables:

- `MaxDeliveryOccurrence`: immutable scheduled intent ID, post/org, parent, due time,
  schedule fingerprint, state, attempt counter, receipt, and successor-planning marker.
- `MaxDeliveryAttempt`: immutable per-attempt target/content snapshot, status, optional
  receipt and operator review actor/time. Unique `(occurrenceId, number)`.

Post.maxDelivery is now a bounded latest-occurrence summary. Historical receipts and
attempts remain in rows, not an accumulating JSON array. A frozen legacy JSON copy preserves
old audit evidence; no new history is appended to it. Post.maxScheduleRevision fences a
paused/cancelled series when it is explicitly resumed. History is not automatically pruned:
deleting a replay guard without another tombstone would make old deliveries unsafe.

## Identity and Inngest deduplication

The first intent is a hash of post ID and schedule fingerprint. Subsequent identities are
hashes of the parent identity, with a unique parent constraint. Scheduled time advances from
that parent's persisted time by intervalInDays, not from worker restart time. The fingerprint
covers schedule generation, publishDate, interval, text/media/settings, channel ID, provider
version and campaign ID. Plaintext tokens are excluded. A separate `Post.maxTarget` additionally fences providerConfigId and the hash of the encrypted token (see MAX-02 compatibility analysis). API preparation stores the actual message and
channel snapshot separately, so audit and webhooks survive later template edits.

The old event ID `post_${post.id}_repeat_${currentIndex}_${post.createdAt.getTime()}` is stable
across execution retries **and across successive iterations**. Repository comments describe
an approximately 24h event dedup window; it is not an occurrence identity and cannot provide
a permanent delivery guard. The local Dev Server 1.52.0 accepted two transport events with the same external ID but created only one function run (GraphQL event inspection); no MAX POST followed for the already confirmed occurrence. Production retention/TTL was not measured.

MAX uses `max_occurrence_${child.id}` for normal repeat dispatch: stable on redispatch, distinct
for each successor. `step.sendEvent` is memoized within its named durable step; PostgreSQL
also prevents duplicates across independent executions and beyond event dedup retention.
The recovery sender intentionally uses a fresh transport event ID but keeps maxOccurrenceId
unchanged, so a cancelled/lost job can resume without creating a new send intent. The
expected attempt counter is fenced too: an old pre-authorization event cannot consume the
operator's grant for a later attempt.

All new MAX publish events carry maxOccurrenceId and maxDeliveryAttempt, including initial schedules, manual retry
and recovery. Unstamped pre-migration MAX events are ignored. A stale event cannot mint a new
occurrence by reading the current template. An occurrence belonging to another post/org,
changed template or cancelled schedule is rejected before MAX HTTP.

## Timing and state transitions

The common workflow plans one child durably and emits it **before** attempting the current
occurrence. The child runs through the same function and sleeps until its persisted due time.
This small MAX-specific ordering is necessary: a timeout of occurrence A must not suppress
independent scheduled occurrence B. There is no custom MAX background scheduler.

Each transition locks the parent Post row inside a short PostgreSQL transaction. No lock is
held during provider HTTP. READY -> STARTED and creation of its attempt row commit before the
provider call. STARTED/REVIEW never automatically resend. A successful response atomically
commits the receipt, CONFIRMED attempt/occurrence and (when still current) the Post summary.
Concurrent activity calls admit only one provider invocation. HTTP POST retries remain off.

A repeated CONFIRMED occurrence returns no new delivery result. Already-confirmed successors
are not redispatched, avoiding an event cascade through the historical chain. The workflow therefore
skips success notification, update-post and webhook, instead of treating an older receipt as
a fresh send. A newly delivered occurrence returns its own result. MAX webhook content, URL,
due time and occurrenceId come from that confirmed attempt, not mutable Post content.
Notification/webhook delivery itself is not exactly-once; receivers can deduplicate by
occurrenceId. Lost step acknowledgement may omit a success notification, rather than
fabricating another publication. The durable receipt remains queryable.

Recovery first initializes due MAX QUEUE roots with no occurrence (a crash between
the post commit and asynchronous workflow initialization). Parent-row locking and
the stable initial ID make concurrent sweeps safe; legacy delivery guards remain intact.
It then scans due READY rows and terminal rows whose successor was not planned. Old
CONFIRMED history with a planned successor is not scanned on every sweep. Stale STARTED rows
become REVIEW after three hours; recovery never re-enqueues them. It may resume the next
READY occurrence. Generic Post QUEUE recovery excludes MAX and remains unchanged for other
providers. Existing hourly recovery can introduce up to an hourly delay for a lost ready job.

## Edits, cancellation and catch-up

- Persisting DRAFT is the business pause; old READY intents are cancelled and schedule
  generation advances. Resume through the existing schedule/save workflow creates a new
  identity even when the original fields are otherwise unchanged.
- Text, channel, date, interval or relevant settings changes invalidate pending old events.
  Saving/rescheduling creates a new initial intent at the explicitly stored publishDate.
  A date in the past is due immediately. Pause first if the intention is to stop delivery.
- A disabled/deleted channel or deleted/DRAFT post cannot start new sends. Explicit
  rescheduling is needed to restart a cancelled chain. A raw transient `post/cancel` event
  alone is not a durable business pause; persist the template state as the UI/service does.
- Changes during an already-started HTTP request cannot retract that request. Its receipt
  is retained on its original occurrence, but cannot unpause or overwrite a newer template.
- Editing/replacing a series never clears an uncertain old occurrence. It remains reviewable;
  resending it is refused if its original fingerprint is no longer current.
- Missed distinct slots are eligible for catch-up, one successor per workflow. There is no
  automatic coalescing/skipping of missed dates. A long outage can therefore create a backlog;
  pause the template before restarting workers if those old slots should not be delivered.

## Operator review

`GET /posts/:id/max-occurrences` returns up to 50 scoped journal rows, each with attempts.
Use the last returned ID as the optional `cursor`; ordering is stable by ID. The normal
Post summary is not a complete history, especially if a later occurrence succeeded while an
earlier one remains uncertain. This API requires post read permission; retry retains post
update permission, authentication/CSRF and billing policy checks.

After inspecting the correct channel and actually stopping/draining old executions, an
operator can authorize **one occurrence/attempt**, without cancelling other releases:

```json
{
  "occurrenceId": "max_<persisted occurrence identity>",
  "expectedAttempt": 1,
  "confirmation": "CHECKED_CHANNEL_AND_STOPPED_OLD_RUNS_ACCEPT_DUPLICATE_RISK"
}
```

Send this to `POST /posts/:id/retry`. The user ID comes from authentication. The journal
atomically marks the previous attempt RETRY_AUTHORIZED with actor/time and grants READY
for that occurrence. The next admission increments its counter. Wrong/stale occurrence,
attempt or org cannot authorize a resend. A lost dispatch after authorization is recovered
from READY; it does not require another send authorization. Other occurrences and the
Post template's publishDate are not reset.

There is no new operator UI or API for asserting an unverified external mid as success.
If a message is found in MAX, do not retry; retain REVIEW and evidence pending an explicit
reconciliation procedure. Cancelling a worker does not prove an already-issued HTTP request
stopped. Exactly-once and automatic eventual delivery of an uncertain occurrence are not
claimed without a MAX idempotency/reconciliation contract.

## Migration and rollout

`20261112100000_max_occurrences` is additive: two tables and a defaulted MAX schedule revision.
It preserves old Post.maxDelivery receipts and history as legacy anchors. CONFIRMED anchors
are never reused as fresh success notifications or guessed periodic slots. Legacy STARTED
becomes REVIEW; legacy READY authorization remains resumable for that original occurrence.
The preceding delivery-guard migration quarantines pre-guard QUEUE/PUBLISHING/ERROR work. An explicitly existing READY authorization is preserved; absence of old evidence is never interpreted as proof of non-delivery.

Legacy anchors do not automatically generate recurring children: the old post-wide journal
cannot prove the ordinal of its last delivery. To start periodic MAX releases after upgrading
an old record, explicitly reschedule/save it with a new future publishDate. New records use
occurrence scheduling immediately. No historical receipt is cleared to start a new release.

The migration and backfill were executed against a throwaway local PostgreSQL DB, including
old confirmed/uncertain/unsent records. No shared dev DB, VPS or production migration was run.
A future rollout must quiesce old workers and old jobs before migration/new code; mixed old
workers cannot enforce these guards. Restoring a database to an older backup can lose the
external delivery evidence and is outside the guarantee. This is a Draft review change,
not approval for live MAX connectivity, merge or deployment.

MAX waits until the persisted absolute occurrence deadline rounded up to the next whole second (less than one second late).
Inngest timers have whole-second resolution and can otherwise wake before the journal's not-before guard; ordinary providers retain their existing scheduling behavior.
