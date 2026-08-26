# Gmail mailbox replica contract

**Status:** Implemented contract
**Canonical provider:** Gmail
**Updated:** August 25, 2026

## Scope and ownership

For each connected Gmail account, Invook continuously replicates every message returned with Spam and Trash included, recognized Gmail system-label memberships, Gmail Draft resources, Gmail's parsed full-format message metadata and bodies, and decoded attachment bytes.

Gmail is canonical for its Important metadata, read/unread, star, Inbox/archive, Trash, messages, and Gmail Draft resources. Invook retains only the known system IDs `IMPORTANT`, `INBOX`, `SENT`, `DRAFT`, `TRASH`, `SPAM`, `STARRED`, and `UNREAD` from message and history data. Opaque Gmail user-label IDs are ignored, and Invook does not synchronize Gmail's user-label catalog. Provider-owned actions write Gmail first and let Gmail history converge PostgreSQL.

The shared `labels` table distinguishes recognized Gmail system metadata from Invook-owned Important, Newsletter, Billing, Others, and custom labels. `message_labels` contains Gmail memberships only. `thread_label_assignments` is the single Invook relationship and is unique by thread. Gmail's `IMPORTANT` membership never determines the Invook Important assignment. Others is a persisted, always-enabled fallback.

The shared `drafts` table distinguishes Gmail resources from local Invook drafts. A Gmail draft retains provider identifiers and metadata. A local draft retains editable text, model provenance, feedback, and Memory evidence without becoming a Gmail resource until the user explicitly promotes it. `gmail_draft_write_operations` is the idempotency and ambiguous-result ledger for Gmail draft create, update, and send operations.

PostgreSQL stores normalized replica state, durable operation checkpoints, and the transactional `temporal_commands` handoff. S3-compatible object storage owns attachment bytes. Temporal Cloud owns Workflow history, schedules, Activity task delivery, and retries.

## Initial synchronization

Embedding backfill and initial Memory wait for the watch-first sequence to complete. Initial thread-label Batch admission is checked after each bounded storage activity and starts once at least 100 eligible threads have committed their full storage checkpoints:

1. Complete Gmail OAuth and capture history cursor H0.
2. Register and persist the Gmail watch immediately.
3. Create one durable initial `mail_sync_run`.
4. Discover all Gmail thread IDs with Spam and Trash included.
5. Group discovered thread IDs into idempotent Temporal activities of at most 10 threads. Each bounded worker fetches a thread with `threads.get(format=full)`, decodes Gmail's already-parsed part tree, fetches any externally referenced attachment bytes, and atomically commits every message in that thread together with its PostgreSQL checkpoint. A retry skips completed threads and safely re-upserts an unfinished thread.
6. Upload attachment bytes and persist normalized message state. Mail becomes browsable without waiting for label analysis; Spam, Trash, and other non-Inbox content never enters label classification. After each successful storage activity, an account-locked admission check creates one durable Batch command only when at least 100 eligible pending threads exist and no submission is queued or active.
7. Synchronize Gmail Draft resources.
8. Under the account advisory lock, apply authenticated notification history from H0 while the snapshot proceeds, then perform a final replay and continue while a newer pending notification cursor exists.
9. Atomically mark the replica ready at the final applied cursor.
10. Flush the remaining partial initial thread-label Batch, then publish embedding and initial Memory derivation work.

A connected account's committed stored data is immediately browsable while synchronization is in progress. All is Gmail `INBOX`, so an Inbox thread appears as soon as it is stored and renders normally with no Invook label until assignment commits. Invook-label views include only matching completed assignments. Missing rows stay unavailable, semantic indexing is not a prerequisite, and Gmail fetching continues independently from label planning and provider-event processing. The final H0 replay remains the only path that marks the replica ready.

A successful normal synchronization does not run a separate full-replica audit.

## Pub/Sub admission

Google Pub/Sub sends OIDC-authenticated pushes to `/v1/webhooks/google-pubsub`. The API validates the audience, service-account identity, exact subscription, envelope, email address, and decimal history ID.

For a matching connected account, one PostgreSQL transaction locks replica state, retains only the highest pending history cursor, and creates an idempotent `gmail.history.catchup` operation checkpoint plus Temporal command. Duplicate and reordered notifications coalesce through the pending cursor and workflow idempotency key. The raw Pub/Sub payload, message ID, email address, and delivery event are not persisted. The route returns `204` without calling Gmail inline. During an initial snapshot, catch-up applies notifications immediately from H0 without marking the replica ready, so newly changed messages can be used while the full snapshot continues. During repair, catch-up applies notifications immediately from the repair run's fresh baseline with the same state-preserving behavior. Catch-up executes on the owning user's `control` Task Queue, independently from that user's `bulk` snapshot queue and every other user's queues. A message becomes browsable only after its canonical Gmail state commits to PostgreSQL.

## Incremental catch-up

Gmail control work is serialized per account with a PostgreSQL advisory lock. A catch-up rereads the committed history cursor, applies one provider-history range, advances the cursor in the same transaction as replica changes, and clears pending state only when the applied cursor reaches it. If a higher notification cursor remains, the worker creates a distinct durable continuation step and yields the account lock; the next control job continues from the new committed cursor.

History work is operation-specific:

- A new or content-changed message uses `messages.get(format=full)`, normalizes Gmail's parsed part tree, stores attachment objects, and upserts relational state.
- A label-only change updates recognized Gmail system memberships from minimal message state without downloading MIME. Opaque Gmail user-label IDs are ignored.
- A deletion creates a durable `gmail.objects.delete` workflow step containing an immutable provider/object-key manifest before deleting relational state.
- A draft-related change lists draft references and refreshes or removes only the affected Gmail Draft resource.
- A newly eligible unassigned Inbox thread is admitted to the durable live label queue in the same transaction that stores the history range. New content in an already-assigned thread never triggers reclassification.
- A label visibility event is emitted in the transaction that commits the assignment or a manual replacement.

Duplicate execution is safe through provider identifiers, expected-cursor checks, unique constraints, workflow idempotency keys, and stable Temporal Workflow IDs. A crashed worker resumes from Temporal history and canonical PostgreSQL state.

## Watch renewal and repair

Watch renewal is a durable daily one-shot action. It persists the renewed watch, schedules its successor, and performs stored-cursor catch-up as a safety net. It does not poll or run a routine full-mailbox audit.

If Gmail rejects an expired history cursor, Invook captures a fresh provider baseline, renews the watch, and creates an exceptional repair-type `mail_sync_run`. Repair uses the same paged thread discovery, bounded full-thread activities, and per-thread atomic checkpoints as initial synchronization. Pub/Sub catch-up is serialized under the account lock and may advance the committed cursor while the snapshot proceeds, but keeps the replica in `repairing`. The finalizer replays from the repair baseline, reconciles the full snapshot, marks the replica ready, and flushes still-unassigned historical Inbox threads into Batch planning. A reconnect-required account follows the same durable repair-run path after successful OAuth.

Permanent credential rejection atomically marks the account `reconnect_required`, fails active Gmail work, and prevents already-published jobs from reactivating terminal state. Transient provider and transport failures retain bounded workflow retries. If an initial synchronization exhausts those retries, the same failure transaction creates one immediate idempotent Gmail control step. That step renews the watch, captures a fresh baseline, and starts a repair run while preserving the highest pending notification cursor. A failed repair does not recursively create another immediate repair; daily watch recovery remains its bounded fallback.

## Provider writes

Explicit user actions for read/unread, star, archive, Trash, and Gmail Draft edits call Gmail first. After a confirmed provider response they enqueue stored-cursor catch-up. Local Gmail-owned state changes only when history is applied. Archive, Trash, and Spam preserve the Invook assignment but hide the thread from All and Invook-label views; restoring Inbox reveals the same assignment. Invook label changes never call Gmail.

## Thread-label analysis

Initial and repair imports use serialized OpenAI Batch work only; they do not make a duplicate newest-200 live-model pass. A thread is eligible only when its atomic full-thread checkpoint is complete, at least one stored message currently carries Gmail `INBOX`, no selected message carries `SPAM` or `TRASH`, its analysis is pending, and no manual Invook assignment exists. During synchronization, account-locked admission starts at 100 eligible pending threads and claims at most 2,000 into a durable `thread_label_batch_submissions` manifest before any provider call. Input construction is bounded by OpenAI's 200 MB file limit and the configured per-Batch input-token ceiling. Only one queued, preparing, or submitted initial label Batch exists per account; its terminal result admits the next durable slice, and Gmail finalization flushes the last group below 100. Gmail storage remains on the tenant's `bulk` lane while Batch submission and result work runs durably and mailbox events make completed labels appear incrementally.

Newly eligible unassigned Inbox threads arriving through Gmail history use the tenant's `live` label lane independently. A live activity rereads current stored Inbox content and makes one structured OpenAI-compatible model call. PostgreSQL validates the thread version and enabled-definition hash again when the result commits, inserts at most one AI assignment, and emits the mailbox event. Content changes in an already-assigned thread do not trigger ordinary reclassification.

Each JSONL request contains only clipped stored Inbox text and the captured enabled-definition snapshot. It never contains raw MIME, HTML, attachments, provider payloads, or Gmail Important as a candidate. The signed OpenAI webhook and worker-startup reconciliation match terminal provider IDs to durable submissions on the live lane. Result application locks each thread, validates its version, definition hash, selected label, confidence, Inbox eligibility, and absence of a manual assignment, then inserts or refreshes the unique AI assignment and emits one mailbox change event. Provider capacity exhaustion, expiration, and invalid per-request output return only the unresolved manifest entries to `pending` and schedule a bounded durable retry; an entry reaches `failed` only after that retry budget is exhausted or a non-retryable provider failure occurs. Duplicate delivery is idempotent.

After the snapshot, content changes in assigned threads do not trigger ordinary reclassification. During an active initial or repair snapshot only, later-discovered content may refresh a pending Batch checkpoint; a late result for an older analysis version is a no-op. A manual selection atomically replaces the one assignment and increments its version, is never changed by snapshot replanning, and makes any late live or Batch result a no-op. Disabling a label keeps existing assignments but removes it from future candidate snapshots. Re-enabling may, only after an explicit 7-, 30-, or 90-day choice, scan current Inbox threads. The label mutation transaction admits one bulk historical-scan coordinator, never a mailbox-sized list of thread jobs. Each coordinator activity uses a typed timestamp cutoff and a stable thread cursor to admit one bounded page plus a durable continuation; retrying a page deduplicates both per-thread work and the continuation. Per-thread scans recheck definition, enablement, and assignment versions before classification and commit, so disabled, edited, manually reassigned, or already-applied work becomes a no-op. A custom-label preview stores one short-lived PostgreSQL receipt containing at most 100 outcomes and hashes of the exact clipped classifier inputs, never email content. When creation requests historical application, the same transaction consumes that receipt and admits the coordinator. A per-thread activity reuses its preview outcome only while the receipt, label definition, historical scan, and recomputed classifier-input hash all match; otherwise it performs a fresh model call. Creating a custom label offers the same optional historical scan, while definition edits affect only future unassigned threads.

Creating a local Invook draft does not create a Gmail draft. Explicit promotion, Gmail Draft editing, and sending retain provider-write idempotency and ambiguous-result evidence in `gmail_draft_write_operations`. AI evidence remains separate after promotion.

## Deletion

Message deletion durably records object cleanup before relational deletion. The cleanup manifest survives worker crashes and no tombstone table is required.

Account deletion enters a durable deleting state. Its cleanup workflow stops the Gmail watch when possible, deletes the account's object-storage keys, and only then deletes the relational account. Transient provider or object-storage failures retry without losing `gmail_account_cleanups` state.

## External configuration

Continuous delivery requires:

- a Pub/Sub topic named by `GMAIL_PUBSUB_TOPIC`, with Gmail allowed to publish;
- an authenticated push subscription targeting `/v1/webhooks/google-pubsub`;
- `GOOGLE_PUBSUB_PUSH_AUDIENCE` matching the OIDC audience;
- `GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL` matching the subscription service account;
- `GOOGLE_PUBSUB_SUBSCRIPTION` matching the full subscription resource name.

Without these resources, Gmail connection and continuous synchronization remain honestly unavailable.
