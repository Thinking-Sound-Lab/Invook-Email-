# Invook product requirements

**Status:** Mailbox-replica and Memory implementation
**Updated:** August 15, 2026

## Product statement

Invook is an AI-native Gmail client that replicates a user's real Gmail mailbox, identifies what matters, and helps find, write, and eventually automate email work. AI is part of the product's operating model rather than a separate compose button.

The first differentiated loop is Memory-backed drafting:

1. Connect Gmail.
2. Build and continuously synchronize a verified replica of real mail.
3. Infer a small, inspectable Memory from full thread context and repeated owner-sent behavior.
4. Draft with only the memories that apply to the current conversation.
5. Treat the user's repeated draft corrections as high-quality feedback.
6. Let the user add, correct, or delete every memory.

There is no separate writing-profile or “voice” object. In Invook, personalization is the concrete, editable Memory used during drafting.

## Product principles

### Real data or an honest empty state

Invook never ships dummy mailbox, contact, memory, label, or draft data. If Gmail, indexing, or a model is unavailable, the interface explains the actual state.

### Opinionated defaults, user authority

A user may add an account-owned Invook label with an explicit description. Before creation, Invook can preview matches by classifying up to 100 recent Inbox threads without persisting those sample results. A new label may optionally scan existing Inbox threads from the last 7, 30, or 90 days. Every thread has exactly one Invook label; a manual choice atomically replaces its previous assignment and is never changed by later messages.

User-written Memory is authoritative. Automatic inference must not silently overwrite it.

### Memory must be inspectable

Every inferred item is a short rule with its source, confidence, and evidence references. The user can edit it into a user-written rule or delete it. Memory is deleted, not disabled.

### Repetition over guesswork

A one-off email or draft edit must not become Memory. Inferred items require at least three pieces of evidence. Global preferences must also span at least three distinct contacts.

### Safe drafting

The model may use facts present in the current thread and applicable Memory. It must not invent availability, promises, attachments, completed actions, or personal facts.

## Primary experience

### Onboarding and indexing

The first page contains only the Invook name and **Sign in with Google**. Better Auth owns this global Invook identity and its database-backed browser session. Its Google OAuth client requests only `openid`, `email`, and `profile`; it never requests Gmail access or offline access.

After sign-in, an authenticated user with no mailbox sees an honest **Connect Gmail** state. Gmail connection uses a separate OAuth authorization flow that may reuse the Google Identity client credentials and must:

- let the user choose an account;
- request the Gmail permissions required by the product;
- return to `/mail` after a valid callback;
- encrypt refresh and access credentials before persistence;
- on first connection, capture H0, register a Gmail watch, and create exactly one durable full-mailbox replication run without blocking the callback;
- on reconnection, refresh only the selected mailbox identity and encrypted credential without resetting the global session, profile, replica, cursor, watch, sync-stage, or mailbox state;
- allow several Gmail mailboxes for one Invook user while preventing one Gmail provider identity from being attached to different Invook users;
- bind each one-time callback state to the authenticated user and, for reconnection, to the existing connected-account ID;
- keep an existing initial replication run, or enqueue stored-cursor history catch-up for a ready replica only when Gmail reports newer history.

Signing out revokes only the Better Auth browser session. It does not revoke Gmail credentials, stop a Gmail watch, cancel durable work, or change a mailbox replica. Mailbox disconnection and account deletion remain explicit lifecycles.

The first connection follows every Gmail thread result page with Spam and Trash included. Bounded activities fetch each thread with `format=full`, atomically store all of its normalized messages and checkpoint in PostgreSQL, and store only attachment bytes in S3-compatible storage. Threads become browsable immediately without waiting for Invook labels. When live classification is configured, eligible Inbox threads active within the hot window (`MAIL_LABEL_HOT_WINDOW_DAYS`, default 14 days before run creation; zero disables; at most `MAIL_LABEL_HOT_WINDOW_MAX_THREADS`, default 1,000, per run) are reserved for the live label lane as each storage batch completes, so recent mail is labeled within minutes. Once 100 eligible non-hot-window Inbox threads are fully stored, an account-locked admission check starts durable OpenAI Batch label analysis while Gmail storage continues; Batch backfills the remainder newest-first and labels appear as results commit. Authenticated Pub/Sub pushes apply from the watch baseline while the initial snapshot continues, without marking the replica ready. The final replay from H0 is still the only path that marks the replica ready and releases indexing and initial Memory. Gmail remains canonical for provider-owned state. The detailed boundary is defined in `docs/gmail-replica-contract.md`.

Each connected account also has one durable daily watch-renewal action. A successful renewal catches up from the stored cursor and schedules its successor. Normal initial synchronization, catch-up, and renewal do not run a full replica audit.

Historical search indexing uses durable 2,000-message provider batches. A signed terminal provider webhook commits current-content embeddings, provider-submission completion, any retry or next-batch Temporal command, and account progress in one PostgreSQL transaction. Duplicate webhook delivery is idempotent. Indexing is complete only when every current message has a complete embedding for the configured model, dimensions, content hash, and index version; unavailable mailbox prerequisites surface as failed rather than continuing in process memory.

### Mail workspace

The left sidebar contains:

- Compose, Search, Settings, Automations;
- All plus built-in and user-created Invook labels owned by the connected account;
- mail views: Starred, Shared, Reminders, Scheduled, Drafts, Done, Sent, Trash.

The center pane shows the selected mailbox or label view in reverse chronological order. Selecting a thread replaces the list with the real thread. Opening an unread thread submits one Gmail thread-level read mutation; Gmail is written first, and the stored replica changes only when provider history is applied. A failed passive mutation remains non-optimistic and exposes an explicit retry.

The right pane is the agent for Find and local Write. It reads authoritative stored mail and may create local drafts, but it has no Gmail mutation tools. During initial synchronization, committed Inbox threads are available immediately and honestly show no Invook label until asynchronous Batch analysis commits one; provider-only non-Inbox views remain available from stored Gmail state. Explicit product actions for archive, read state, star, Trash, and Gmail Drafts write Gmail first and converge through provider history. Agent-initiated sending, recurring Inbox Zero, and standing approvals remain unavailable.

### Label settings

Settings lists the built-in Important, Newsletter, Billing, and Others definitions plus user-created Invook labels. Labels are permanent: a user can enable or disable any label except the always-enabled Others fallback. Disabled labels keep their existing thread assignments but are excluded from classification of new Inbox threads. Re-enabling asks whether to scan existing Inbox threads from the last 7, 30, or 90 days; the scan replaces an assignment only if its version has not changed since the scan was queued.

The mailbox sidebar groups All, Important, Starred, Drafts, Sent, Spam, and Trash under Mail. All and every Invook-label view contain only Gmail Inbox threads. Important is Invook-owned classification; Gmail's `IMPORTANT` membership remains provider metadata and is not used as the product label.

### Memory settings

Settings contains a Memory section with exactly three tabs.

#### Preferences

Global rules that should affect every draft. A user can add them manually. During initial analysis, Invook may infer a preference only when the same behavior appears in at least three messages to at least three different contacts.

Examples of valid categories include brevity, greeting behavior, sign-off behavior, formatting, and how directly the owner answers. These examples describe categories only and are never inserted as product data.

#### Contacts

Rules for communication with one normalized contact email. A contact memory requires repeated evidence from at least three eligible sent messages involving that exact contact.

Contact Memory describes how the owner communicates with that person. It must not become an unsupported profile of the other person.

#### Scheduling

Rules that apply only when the current conversation coordinates a meeting, call, date, or time. A scheduling memory requires repeated evidence from at least three scheduling messages.

### Memory controls

For every Memory item, the user can:

- see whether it was added by the user, inferred from sent mail, or learned from repeated draft feedback;
- see the number of supporting sent messages or edited drafts;
- edit its type, statement, and contact email where applicable;
- delete it.

Deleting removes the active record and its text. A non-reversible fingerprint tombstone prevents the exact same automatic inference from returning. Editing an inferred item similarly blocks the former exact version and saves the corrected version as user-authored.

## Batch analysis

Embeddings are not required for Memory v3 or labels. Initial and repair imports label each thread through exactly one path. Inbox threads active within the configured hot window (`MAIL_LABEL_HOT_WINDOW_DAYS` before run creation, capped at `MAIL_LABEL_HOT_WINDOW_MAX_THREADS` per run) are reserved once for the live structured-classification lane under the account label lock before Batch admission runs; a live failure or missing live-model configuration returns the thread to the Batch pool. Every other thread uses serialized durable OpenAI Batch submissions admitted from 100 eligible complete Inbox threads, claimed newest-first by latest message, and capped at 2,000 requests, 200 MB, and the configured input-token ceiling. Admission is checked after each bounded Gmail storage activity, only one submission may be queued or active per account, and Gmail finalization flushes the remainder below 100. Newly eligible unassigned Inbox threads arriving after synchronization use the live structured-classification lane. Later content discovered during the same snapshot advances the pending Batch analysis version; manual labels remain authoritative, and ordinary post-snapshot content does not reclassify an already-labelled thread.

For initial Memory, the worker uses the selected OpenAI or Azure OpenAI native Batch API as follows:

1. Select real threads containing at least one eligible owner-sent message. Include incoming messages as context, but allow only eligible owner-sent messages to become evidence.
2. Normalize external email addresses and remove the mailbox owner's address.
3. Build one natural global request across the mailbox for Preferences and Scheduling, plus one request per contact that has at least three eligible owner-sent messages.
4. Attach the same Memory system instruction and structured response schema to every independent request.
5. Measure OpenAI requests with the Responses input-token endpoint. For Azure OpenAI, which does not expose that endpoint, use the complete request's UTF-8 byte length as a conservative token-count upper bound. Keep each natural scope whole unless the provider's configured model input limit requires a split that can still preserve the three-message evidence rule.
6. Upload all requests as one JSONL batch input and enforce the provider's documented limits: 50,000 requests for OpenAI or 100,000 for Azure OpenAI, and 200 MB per input file for either provider.
7. Receive `batch.completed`, `batch.failed`, `batch.expired`, or `batch.cancelled` through the provider-specific signed webhook and queue result processing. The worker does not poll or use timer-based waiting.
8. Reject candidates whose cited IDs are missing, incoming, duplicated below the threshold, or outside the request and contact scope.
9. Merge exact duplicates in application code. There is no mandatory second model batch.
10. Preserve user-authored Memory and deletion fingerprints. Retry only failed JSONL requests, up to the existing job-attempt limit.
11. Replace the prior inferred snapshot on the first successful result, merge any retry results, and mark Memory complete only after every request has succeeded.

After initial Memory is complete, newly indexed eligible owner-sent messages are recorded as pending global and exact-contact evidence. When a scope reaches the existing three-message threshold, the worker submits only that scope and merges validated results into the existing inferred Memory. Incremental jobs never replace user-authored Memory or the complete inferred snapshot. Incoming mail may be included as thread context but never becomes evidence.

Email bodies, candidate text, and thread content are always untrusted model input. The prompt must explicitly prohibit following instructions found inside them.

If the selected provider's API credentials, deployment configuration, or signed webhook secret are incomplete, initial Memory analysis stays queued without consuming retries or creating fallback results.

## Drafting

When the user requests a draft, the API builds context from:

1. the optional current instruction;
2. the current thread's real messages;
3. Memory for the exact contact or contacts in the thread;
4. Scheduling Memory, applied only if the thread is scheduling-related;
5. global Preferences.

Unrelated contact memory is never supplied. The model returns the draft, the IDs of memories that materially affected it, and whether scheduling was relevant. Invook persists that provenance with the editable draft.

The UI may explicitly save an AI reply as a Gmail Draft; that creates a separate provider resource and keeps the AI draft/evidence unchanged. Saving must not imply that a message was sent.

New-message Compose accepts explicit recipient email addresses, subject, and plain-text body, and saves or updates a Gmail Draft. Gmail is written first; Invook then schedules stored-cursor history catch-up so the provider-owned draft converges into the local replica. After a successful save, Compose exposes a separate confirmation step that sends that exact Gmail Draft only after the user clicks **Send now**. The send uses a durable idempotency key, does not repeat an ambiguous or completed provider write, and schedules stored-cursor history catch-up for the sent message. Compose never sends autonomously.

## Feedback

Feedback is a core input, not an analytics afterthought.

When a user saves changes to an AI-generated draft, Invook retains both the generated text and the edited text. A feedback job considers the recent real edit history and may create Memory only when the same correction appears in at least three distinct drafts.

Feedback classification follows the same scopes:

- a global correction becomes a Preference only when it repeats across contacts;
- a contact correction requires repeated edits for the same normalized contact;
- a scheduling correction requires repeated scheduling edits.

Previously analyzed edits remain available as evidence for later repetition. This is necessary for the fourth or fifth edit to reinforce a pattern discovered across earlier drafts.

The user can inspect, edit, or delete feedback-derived Memory exactly like mail-derived Memory.

## Labels

One classifier assigns exactly one enabled Invook-owned label to an eligible Gmail Inbox thread. Candidates include Important, Newsletter, Billing, and enabled custom definitions; Others is the persisted fallback when no candidate matches. Only messages currently carrying Gmail `INBOX` and neither `SPAM` nor `TRASH` are classifier input. Gmail `IMPORTANT` is retained only as provider metadata. Opaque Gmail user-label IDs are ignored.

`thread_label_assignments` is the single visible and durable relationship, constrained to one row per thread. It stores AI or user source, confidence and model provenance, definition version, and an assignment version used to protect historical scans from overwriting later manual choices. Archive, Trash, and Spam preserve the assignment but remove the thread from All and Invook-label views; restoring it to Inbox reveals the same assignment without reclassification. An unlabelled thread first moved into Inbox is classified. Manual replacement is the only ordinary post-snapshot way an assigned thread changes label; automatic replacement is limited to a newer analysis version caused by later content in the same active initial or repair snapshot.

All is Gmail `INBOX`: a stored Inbox thread is visible immediately even when it has no Invook assignment. While initial fast or Batch analysis is pending, the row renders normally without a placeholder label or analysis indicator. When snapshot replanning refreshes an existing AI label, its last committed assignment remains visible until the newer version commits. Fast and Batch completions apply validated results, emit mailbox change events, and treat any existing manual assignment as authoritative. Signed terminal webhooks and startup reconciliation durably recover Batch completion; provider-capacity failures and invalid individual results retry only their bounded durable manifest entries rather than permanently hiding their classifications.

## Architecture

```text
Browser
  -> Next.js UI
  -> /v1 reverse proxy
  -> Fastify API
       -> Better Auth and Google Identity
       -> separate Gmail OAuth and Gmail API
       -> Drizzle repositories
       -> PostgreSQL

Worker
  -> PostgreSQL product state, checkpoints, and transactional Temporal commands
  -> Temporal Cloud Workflows, schedules, task delivery, and retries
  -> Gmail snapshot, history replay, Pub/Sub catch-up, watch renewal, and repair runs
  -> S3-compatible attachment object storage
  -> Temporal Activities for search indexing, Invook-label analysis, and initial or incremental Memory
  -> selected OpenAI or Azure OpenAI Batch provider for Memory
  -> selected OpenAI Batch provider for initial Invook-label analysis
  -> configured model endpoint for validated incoming-thread label classification
  -> configured model endpoint for feedback and drafts
  -> validated results in PostgreSQL
```

The repository remains an open-source-friendly pnpm workspace with `apps`, `packages`, and `docker`. Next.js is UI-only. Database, Gmail, token encryption, and model operations remain in server-side packages.

### Database

Drizzle owns the PostgreSQL schema and ordered SQL migrations. Current application tables are:

- `profiles`
- `connected_accounts`
- `account_secrets`
- `gmail_replica_states`
- `gmail_watch_states`
- `labels`
- `threads`
- `messages`
- `message_labels`
- `thread_label_assignments`
- `thread_label_batch_submissions`
- `message_attachments`
- `drafts`
- `message_embeddings`
- `memory_entries`
- `memory_pending_evidence`
- `memory_deletions`
- `gmail_draft_write_operations`
- `mail_sync_runs`
- `gmail_sync_pages`
- `gmail_sync_items`
- `workflow_steps`
- `temporal_commands`
- `embedding_batch_submissions`
- `gmail_account_cleanups`
- `mailbox_change_events`

Temporal Cloud is the only asynchronous executor and owns Workflow history, Activity task delivery, retry timing, and scheduled starts. PostgreSQL retains canonical product state, user-visible progress, page-level resumability, provider-Batch correlation, and a transactional `temporal_commands` handoff across the PostgreSQL/Temporal boundary. New tables should be added only for a working feature and demonstrated query need.

## API requirements

Current mailbox, label, Memory, and draft endpoints include:

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/auth/sign-in/social` | Begin Better Auth Google Identity sign-in |
| `POST` | `/v1/auth/sign-out` | Revoke the current Better Auth session |
| `GET` | `/v1/connections/gmail/start` | Begin an authenticated Gmail add or reconnect flow |
| `GET` | `/v1/connections/gmail/callback` | Consume the user-bound Gmail OAuth callback |
| `GET` | `/v1/mailbox/shell` | Return the authenticated mailbox shell and account state |
| `GET` | `/v1/mailbox/sidebar-counts` | Return focused sidebar counts for the connected mailbox |
| `GET` | `/v1/mailbox/threads` | Return one cursor-bounded mailbox thread page for a validated view |
| `GET` | `/v1/mailbox/threads/:threadId` | Return one authorized stored thread and its messages |
| `GET` | `/v1/mailbox/settings` | Return mailbox Memory and Invook label settings on demand |
| `POST` | `/v1/mailbox/sync` | Durably queue Gmail history catch-up from the stored replica cursor |
| `DELETE` | `/v1/mailbox/account` | Stop the watch, clean object storage, then delete the connected account |
| `GET` | `/v1/attachments/:id/download` | Authorize the attachment and download its private stored bytes |
| `GET` | `/v1/mailbox/events` | Stream authenticated durable mailbox-change events over SSE |
| `POST` | `/v1/webhooks/google-pubsub` | Authenticate a Gmail Pub/Sub push and coalesce its pending cursor |
| `POST` | `/v1/labels/preview` | Preview a custom label against up to 100 recent Inbox threads |
| `POST` | `/v1/labels` | Create a permanent custom Invook label and optionally enqueue a 7-, 30-, or 90-day Inbox-thread scan |
| `PATCH` | `/v1/labels/:labelId` | Update a custom definition for future unlabelled threads |
| `PATCH` | `/v1/labels/:labelId/enabled` | Enable or disable a label and optionally scan a recent window when re-enabling |
| `GET` | `/v1/memories` | Return the connected account's real Memory and status |
| `POST` | `/v1/memories` | Add a user-authored item |
| `PATCH` | `/v1/memories/:id` | Correct an item and make it user-authored |
| `DELETE` | `/v1/memories/:id` | Delete an item and retain only its fingerprint tombstone |
| `POST` | `/v1/threads/:id/drafts` | Generate a draft from the thread and applicable Memory |
| `PATCH` | `/v1/drafts/:id` | Save an edit and queue feedback analysis when changed |
| `POST` | `/v1/drafts/:id/save-to-gmail` | Create a distinct Gmail Draft from saved AI reply evidence |
| `POST` | `/v1/gmail/messages/:id/actions` | Apply read, star, archive, or Trash state at Gmail first |
| `PUT` | `/v1/gmail/threads/:id/read-state` | Apply one read-state change to every Gmail message in an owned thread |
| `PUT/DELETE` | `/v1/gmail/drafts/:id` | Update or delete an existing Gmail Draft resource |

Every product mutation requires an authenticated Better Auth database session and an allowed request origin. IDs and bodies are validated before repository calls. User ownership is enforced in every product lookup.

## Initial non-goals

- Embedding-based Memory extraction or retrieval.
- A broad inferred relationship/personality graph.
- Automatic sending or autonomous mailbox mutations without an explicit user action.
- Calendar execution.
- General agent chat that claims unsupported actions.
- Multiple email providers.
- Cloud-provider-specific deployment design.

## Success criteria

The Memory-first slice is successful when:

- a connected Gmail mailbox can be indexed without dummy data;
- the three Memory tabs show real inferred/user/feedback entries or honest empty states;
- no inference is persisted with fewer than three valid evidence items;
- global preferences are rejected unless their evidence spans three contacts;
- unrelated contact memory never reaches a draft request;
- users can add, correct, and delete Memory;
- a deleted exact inference does not reappear on rebuild;
- a repeated edit can influence later drafts through feedback-derived Memory;
- unconfigured AI returns an honest pending or configuration state;
- local Docker startup and standard PostgreSQL migrations work from a clean checkout.

## Later work

After the Memory loop is measured with real use:

1. evaluate broader factual retrieval independently of Memory extraction;
2. add sending, scheduling, reminders, and safe automations.
