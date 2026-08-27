# Mail navigation performance plan

**Status:** Implemented for locally verifiable slices; real-mailbox acceptance measurements pending
**Updated:** August 18, 2026
**Scope:** Mail workspace navigation, mailbox API reads, PostgreSQL queries, and mailbox event invalidation

## Implementation record

Implemented on August 17, 2026:

- Replaced the full mailbox workspace with focused shell, sidebar-counts, thread-page, thread-detail, and settings contracts, database reads, and authenticated Fastify endpoints. The legacy contract, serializer, database operation, and route were deleted.
- Moved list pagination to the focused thread endpoint, made settings load on demand, removed progress aggregates from navigation, removed `await connection()`, and introduced a persistent `/mail` layout with explicit loading, error, reconnect, stream-connecting, and stream-degraded states.
- Replaced open event payloads with one typed insertion boundary and an allowlisted browser projection. Draft events resolve internal thread identifiers before publication. `repair_complete` was removed with generated migration `0025_opposite_inertia.sql`.
- Replaced UUID-and-timestamp replay with the resolved Decision D lifecycle. The internal PostgreSQL notification now carries `eventId`, `userId`, and `accountId`; scoped failures invalidate only the proved user, while malformed or mismatched scope uses the broader fallback.
- Added privacy-safe `Server-Timing: api;dur=...` instrumentation and propagation of an incoming request identifier from Next.js to Fastify. It records no mailbox content or provider identifiers.

Review correction implemented on August 18, 2026:

- Scoped client continuation pages and cursors to a server-issued canonical page generation. A same-view `router.refresh()` now discards every previously loaded continuation page immediately, returns to the refreshed first page and cursor, and aborts an in-flight continuation request. This preserves cursor ordering and membership correctness while Next.js retains the mounted client component.

No signed-in mailbox, `DATABASE_URL`, `TEST_DATABASE_URL`, or running local services were available in this worktree. Therefore no real browser/Gmail p50, p95, threshold-exceedance rate, payload-size, query-plan, or before/after navigation sample is recorded, and the target acceptance criteria remain externally unverified. The implementation deliberately retains the measured page-size hypothesis of 100 and adds no speculative SQL index, denormalized count projection, private-data cache, thread prefetch, or progress projection without those measurements.

Local verification completed on August 17, 2026: focused contract, API, database, listener-lifecycle, and web relevance tests passed; `make verify` passed including the production Next.js build; and `docker compose -f docker/compose.yml config --quiet` passed. Migration generation and inspection completed. A clean migration apply, database-backed integration tests, live listener loss/recovery, real Gmail convergence, and browser performance measurements remain unverified because the required services and credentials were unavailable.

## Problem statement

Opening a sidebar view or a mail blocks on a dynamic React Server Component render, an Axios request to the Fastify API, reconstruction of the full mailbox workspace, many PostgreSQL queries, and response serialization. The same broad workspace path serves every destination, even when the destination needs only a thread list or one thread.

### Verified costs in the current path

The following were read directly from the repository. They are structural facts, not measurements; Phase 0 assigns them durations.

- A list navigation executes 13 mailbox queries excluding authentication: 9 in `getMailboxWorkspace` (`packages/database/src/repositories.ts:1185`, `1292`, `1333`, `1337`, `1359`, `1378`, `1388`, `1484`, `1509`) and 4 in `serializeWorkspace` (`apps/api/src/serializers.ts:22`).
- Opening a thread executes 19 queries: the same 13 plus the selected-thread read (`repositories.ts:1237`), messages, the Invook draft, provider drafts (`repositories.ts:1599`), attachments, and message Gmail labels (`repositories.ts:1686`).
- Both counts are structural upper bounds. The label-membership and attachment reads (`repositories.ts:1484`, `1509`, `1686`) execute only for a non-empty identifier list, so Phase 0 records the executed query count per flow rather than assuming these totals.
- Account progress is already delivered by a dedicated stream. `AccountPipelineStripe` subscribes through `useAccountSyncEvents` and the account-sync store (`apps/web/src/components/mail/account-pipeline-stripe.tsx:20`, `apps/web/src/hooks/use-account-sync-events.ts`, `apps/web/src/stores/account-sync/store.ts`).
- `serializeWorkspace` re-reads `connectedAccounts.syncState` (`repositories.ts:1804-1834`) that `getMailboxWorkspace` already selected (`repositories.ts:1188`).
- The response carries up to 100 threads (`repositories.ts:101`, `1332`, `1416`), each row computing two correlated `EXISTS` subqueries over messages, message labels, and labels, and each carrying its Invook and Gmail label memberships. The payload is serialized twice: API JSON, then the React Server Component payload to the browser.
- Every response also carries all memories, all Invook label definitions, and all sidebar counts, regardless of the destination screen. Memories are consumed only inside the settings dialog reached from the sidebar (`apps/web/src/components/mail/mail-sidebar.tsx`, `apps/web/src/components/settings/settings-dialog.tsx`, `apps/web/src/components/settings/memory-settings.tsx`).
- Infinite scrolling requests the full workspace endpoint for one more page of thread rows (`apps/web/src/components/mail/mail-list.tsx:273`).
- **Opening a thread triggers a second full workspace load.** The reader marks the thread read (`apps/web/src/components/mail/thread-read-tracker.tsx:32`), the API writes to Gmail and enqueues a history catchup (`apps/api/src/services/gmail-thread-read-state.ts:67`), the worker publishes `history_applied` (`packages/database/src/replica.ts:834-845`), and the browser calls `router.refresh()` (`apps/web/src/hooks/use-mailbox-events.ts:11-12`). The refresh re-runs the 19-query path with the selected thread attached.
- Mailbox events cause an unconditional whole-route refresh. `MailboxChangeEvent` carries only `id`, `accountId`, `changeType`, and `createdAt` (`packages/contracts/src/index.ts:368-378`), so the browser cannot tell whether a change affects the visible screen. Additional unconditional refreshes are issued directly by `draft-composer.tsx:60`, `draft-composer.tsx:82`, `draft-composer.tsx:99`, `smart-label-controls.tsx:32`, and `mailbox-refresh-button.tsx:22`.
- Settings writes pay the full workspace cost. The settings dialog renders inside `/mail`, so creating or deleting an Invook label or a memory refreshes the same route (`apps/web/src/components/settings/label-settings.tsx:43`, `label-settings.tsx:55`, `apps/web/src/components/settings/memory-settings.tsx:81`, `memory-settings.tsx:89`), including the unbounded aggregate.
- Search navigation awaits the workspace read and then the search read sequentially (`apps/web/src/app/mail/page.tsx:121`).
- `await connection()` in `apps/web/src/app/mail/page.tsx:68` is redundant. `apps/web/src/lib/api.ts:15` calls `headers()`, which already opts the route out of static rendering.

### Existing behavior to preserve

- Click feedback is already implemented with `useLinkStatus` (`apps/web/src/components/mail/mail-navigation-pending.tsx:16`).
- Durable history payloads carry changed and refreshed thread IDs, while thread-label events carry affected thread IDs through the shared typed insertion boundary (`packages/database/src/replica.ts` and `packages/database/src/thread-label-analysis.ts`). Targeted invalidation therefore needs no additional durable checkpoint.
- `apps/web` must not import database, Gmail, object-storage, or credential code, so the web-to-API hop is mandatory and stays.

### Durable mailbox event payloads as they exist today

Targeted invalidation consumes these payloads, so the plan records their real shapes rather than an idealized one. The column is `jsonb` with a `{}` default (`packages/database/src/schema.ts:1256`) and the insert helper accepts `payload?: Record<string, unknown>` (`packages/database/src/replica.ts:242`), so no type enforces any field today.

- `history_applied` has two producers with different shapes: `{ changedThreadIds, reason: "message_refresh" }` (`replica.ts:274-280`) and `{ historyCursor, changedThreadIds, refreshedThreadIds }` (`replica.ts:839-843`).
- `labels_changed` distinguishes automatic analysis resolution from a manual decision and carries `affectedThreadIds` for both variants (`thread-label-analysis.ts`).
- `drafts_changed` has three producers carrying either `{ draftCount }` (`replica.ts:365`) or `{ providerMessageId }` (`replica.ts:417`, `replica.ts:443`). None carries a thread or Invook draft identifier, and `providerMessageId` is a provider identifier.
- `replica_ready` carries `{ historyCursor }` (`replica.ts:913`).
- `repair_complete` is declared in the schema check constraint (`schema.ts:1254`, `schema.ts:1266`), the insert helper union (`replica.ts:239`), and the browser contract (`packages/contracts/src/index.ts:374`), but no code emits it.

Four consequences constrain Phases 2 through 5:

- One `changeType` does not imply one payload shape. A discriminated union keyed on `changeType` alone cannot describe `history_applied`, because the `message_refresh` producer omits `historyCursor` and `refreshedThreadIds`.
- `changedThreadIds` and `refreshedThreadIds` have different jobs. `changedThreadIds` records a canonical row or Gmail-label-membership change that can alter list presentation, membership, ordering, or counts. `refreshedThreadIds` also records a visible label refresh whose memberships compare equal, because `replaceGmailMessageLabels` still advances `messages.providerHistoryId` (`repositories.ts:2736-2742`). The existing partial-replica integration test proves the important case: `changedThreadIds` is empty, `refreshedThreadIds` contains the thread, and the selected message history ID advances (`partial-replica.integration.test.ts:537-555`). That history advance is the signal used by `ThreadReadTracker` to retry after coalesced `UNREAD` removal and addition (`apps/web/src/components/mail/thread-reader.tsx:75-82`). Therefore list and count invalidation may use `changedThreadIds`, but open-thread canonical convergence must use `refreshedThreadIds` or an equivalently explicit history-touched set.
- A newly arrived message is therefore absent from `changedThreadIds`, because its label analysis is queued. Its list row, and the ordering change it causes, are announced by the later `labels_changed` event. Today's whole-route refresh hides that dependency.
- The API exposes none of this yet. `writeEvent` (`apps/api/src/routes/mailbox-events.ts:26-36`) projects only `id`, `accountId`, `changeType`, and `createdAt`, discarding the payload the repository already selects (`replica.ts:959`).

Mailbox data remains server-owned. This plan does not move threads, messages, labels, read state, or counts into Zustand, and it does not introduce optimistic Gmail state.

## Goals

Navigation should feel immediate while server and provider authority are preserved.

The Phase 0 baseline is the normative source for targets. The values below are the entry hypothesis and must be replaced by measured targets once the baseline exists:

- Visible click or selection feedback within 100 ms.
- Warm sidebar navigation completed at p95 within 300 ms, with no more than 5% of recorded acceptance samples exceeding 900 ms.
- Warm thread opening completed at p95 within 400 ms, with no more than 5% of recorded acceptance samples exceeding 1200 ms.
- Tail behavior is accepted on p95 and the threshold-exceedance rate. Always report the worst recorded sample for diagnosis, but do not use a single maximum as a pass/fail gate because it becomes less stable as the sample set grows.
- An exceedance-rate gate needs enough expected exceedances to be stable, so it carries its own sample-size floor. At the 200-sample acceptance minimum, a 5% threshold expects about 10 exceedances at the limit, while a 1% threshold expects 2: a build sitting exactly at a 1% budget would fail roughly a third of the time, and a build at twice that budget would pass roughly a quarter of the time. Tighten a gate to 1% only for a flow whose harness recorded at least 1000 completed samples. Report p99 as diagnostic only at that same 1000-sample floor.
- No thread-list or thread-detail navigation waits on an aggregate whose cost grows with total mailbox size. Sidebar counts and account progress are independent resources with their own measured budgets.
- A list navigation response stays under a measured byte budget recorded in the baseline, and carries no message body, attachment, draft, memory, or settings data.
- No full mailbox refresh for an event unrelated to the visible resources. A client-initiated mutation revalidates only the affected canonical resources unless a durable version or correlation proves that the client already holds the same or newer state.
- Authorization, multi-account isolation, pagination correctness, and Gmail state fidelity are preserved.

If the baseline shows a target is unreachable without violating an invariant, revise the target in this document with the measurement that forced the change.

## Non-goals

- Do not store server-owned mailbox data in Zustand or another competing client store.
- Do not make a mail appear read before the canonical mutation succeeds.
- Do not introduce timer-based polling, `setTimeout`, or timeout-driven invalidation.
- Do not add speculative indexes, denormalized count tables, or private-data caching without measurements proving they are needed.
- Do not prefetch thread bodies or attachments for rows merely because they are visible. Prefetching one thread on an explicit navigation intent, such as pointer hover, keyboard focus, or the adjacent thread while a thread is open, is an allowed candidate that must be justified by measurement and bounded to one in-flight prefetch.
- Do not introduce synthetic mailbox data into product flows.

## Target architecture

The `/mail` route should keep a stable shell mounted and replace only the center pane on navigation.

```text
Persistent /mail shell
├── Account shell and sidebar labels
├── Sidebar-counts resource
├── Center pane
│   ├── Thread-list resource
│   ├── Thread-detail resource
│   ├── Compose view
│   └── Search resource
├── Account-progress stream
└── Mailbox event subscriber
    └── Revalidates only affected resources
```

The API and repository layers expose focused resources instead of rebuilding one full workspace for every screen. PostgreSQL remains the replicated mailbox source of truth for reads, and Gmail remains authoritative for provider state.

## Resolved decisions

These decisions were resolved against the installed Next.js 16.3 and postgres.js 3.4.7 implementations before the affected contracts were changed.

### Decision A: keep search-parameter URLs

Next.js 16.3 `Link` can prefetch URLs that contain search parameters, and runtime prefetches can vary on those parameters. Search parameters therefore do not disable prefetch. Route segments still provide filesystem loading boundaries, but no real-mailbox measurement was available that proved a route-segment migration faster than the existing URLs. The implementation keeps `/mail?view=...`, `/mail?thread=...`, and `/mail?surface=...`, preserves `useLinkStatus` click feedback, and adds the `/mail` loading and error boundaries. Search-parameter navigation continues to use the link pending indicator while the focused Server Component read completes.

### Decision B: focused Server Component reads with a coarse refresh fallback

The focused resources remain Server Component reads. A private, cookie-scoped shared tag cache was not proved safe across self-hosted instances, and a client query cache would add a second mailbox-data owner. Event and mutation convergence may therefore use `router.refresh()` as the documented coarse fallback. This relaxes per-resource request isolation, but it never relaxes the resource contract: the legacy workspace contract, repository operation, serializer, and `GET /v1/mailbox` route are removed. Every refresh can execute only the persistent shell, sidebar-counts, and currently mounted focused center-pane endpoint. Settings mutations reload only `MailboxSettings`, and account progress performs no mailbox read.

### Decision C: do not suppress canonical events

Neither `threads.contentVersion` nor `gmailReplicaStates.historyCursor` proves that a coalesced event contains only one client mutation. The implementation therefore performs no self-event suppression. A matching open thread is refreshed from its canonical focused detail endpoint when `changedThreadIds` or `refreshedThreadIds` includes it. This preserves the coalesced read-state convergence case without optimistic Gmail state.

### Decision D: subscription health plus canonical-read readiness

The unsafe timestamp-and-random-UUID replay path, SSE `id:` frames, and `Last-Event-ID` handling are removed. The installed postgres.js listener supports both the `onlisten` subscribe/re-subscribe callback and the connection-level `onclose` callback. The database wrapper now exposes both transitions.

The lifecycle is:

- Starting: no readiness is allowed until `onlisten` proves a live notification subscription.
- Healthy for a user: the subscription is live, the stream is registered, and `getMailboxEventRecoveryContextForUser` has completed successfully for the current subscription generation. Only then is `mailbox_stream_ready` emitted.
- Degraded globally: listener `onclose`, re-subscription, malformed notification JSON, or a notification whose durable row has mismatched scope closes every affected open stream and invalidates its recovery generation. Browser `EventSource` reconnect is platform-native; no timer or polling is added.
- Degraded for one authenticated user: a valid scoped notification carries `eventId`, `userId`, and `accountId`; a missing row or failed canonical lookup closes only that user's streams. A malformed or genuinely unscoped failure uses the broader fallback.
- Recovered: postgres.js reports a successful subscription, the browser reconnects, the server registers the stream before its recovery read, and the canonical account read succeeds in the same subscription generation. A failed recovery read closes the stream and emits no readiness.

Readiness uses the Decision B coarse refresh fallback, but that refresh is built exclusively from the focused shell, counts, and visible list/detail/search/settings contracts. It can never restore or retain the deleted full-workspace read. A notification committed before registration is covered by the canonical readiness read; a notification concurrent with that read may cause one redundant focused refresh and remains correct.

## Phase 0: Establish the original baseline and resolve open decisions

Add privacy-safe timing instrumentation and record the current, unoptimized behavior before changing page size, query shape, refresh behavior, or resource ownership. Then settle Decisions A, B, C, and D.

Measure these stages separately:

- Browser click to visible pending state.
- Browser click to completed navigation, defined as the destination center pane painting its requested server data.
- For an unread thread, provider-write admission to canonical PostgreSQL convergence. Report this separately from navigation completion.
- Next.js server render and upstream API duration.
- Fastify authentication and authorization.
- Route service and repository execution.
- Individual database query groups.
- Serialization duration, response bytes at the API hop, and React Server Component payload bytes at the browser hop.

Use structured metrics or `Server-Timing` headers. Propagate a privacy-safe trace identifier across the browser, Next.js, Fastify, and repository measurements so stages from one navigation can be correlated. Log identifiers, statuses, counts, and durations only; never email content, provider payloads, credentials, attachment data, or filenames.

Drive the samples from a named, reproducible harness rather than by hand. A volume this large will not be produced manually, and leaving the harness unspecified means the recorded baseline silently shrinks to whatever was convenient. The harness drives a real signed-in session against a real connected mailbox and introduces no synthetic mailbox data. Record what it is, how to rerun it, and which flows it covers.

The timing instrumentation is permanent product code, because every later slice must be compared using the same method. Measure its own overhead in Phase 0, record an explicit overhead budget, and keep it inside the privacy boundary stated above. Do not add instrumentation that must be removed to meet the performance targets it measures.

Discard at least 20 warm-up navigations before recording samples. Record at least 200 completed warm samples for every acceptance flow, which supports p50, p95, a 5% threshold-exceedance rate, and the worst recorded sample:

- All to Important.
- All to Starred.
- Thread list to an already-read thread detail.
- One already-read thread to another thread.
- Thread detail back to the previous list.

Record an exceedance threshold for every acceptance flow alongside its percentiles, plus the measured exceedance rate against it and the sample count supporting that rate. The Goals section gates acceptance on both the threshold and the rate, so a baseline that omits them leaves those gates undefined.

Record at least 30 samples for diagnostic flows, which report p50 and the worst recorded sample. A p95 from 30 samples is the second-worst observation, so report it as an order statistic rather than as a stable percentile estimate:

- Infinite-scroll page load.
- Idle screen receiving an unrelated mailbox event.
- Initial mailbox-event stream registration, a reconnect that requires a focused snapshot, and a notification-subscription re-establishment while the browser stream stays open. Record the number of focused reads each readiness snapshot causes, not only its duration, because Decision D's cost is a read count.
- Opening a real unread thread through canonical read-state convergence. Record the cost of the redundant full-workspace read that the current post-mutation refresh performs as its own number; it is the interim cost accepted until Phase 4 narrows it. State the available sample size.

Use the same deployment mode, infrastructure, mailbox, browser profile, network conditions, and measurement method for before-and-after comparisons. Record the distinct build identifier for every slice; the code build necessarily changes between before and after measurements. State the mailbox size, thread count, message count, build identifier, and environment with the results.

For slow SQL paths, run `EXPLAIN (ANALYZE, BUFFERS)` with representative stored data. Record p50, p95, the exceedance rate against the recorded threshold, the worst recorded sample, query count, response bytes, and the dominant time segments. Report p99 only for a flow that reached at least 1000 completed samples, and never as an acceptance gate below that count.

Record the baseline in this document. A baseline that lives only in a terminal session is not a baseline.

### Exit criteria

- A reproducible original baseline exists for every representative flow and is written down with its data-set and environment description.
- The measurement harness is named, rerunnable, and free of synthetic mailbox data, and the instrumentation's own overhead is measured against a recorded budget.
- The dominant latency contributors are supported by measurements, and the Goals section has been updated with measured targets and their supporting sample counts.
- Every acceptance flow has a recorded exceedance threshold, a recorded exceedance rate against it, and a sample count sufficient for the rate applied to it.
- The interim cost of the current post-mutation full-workspace refresh is recorded as its own number.
- Decisions A, B, C, and D are recorded with their rationale and rejected alternatives, including Decision B's fallback, Decision C's evaluation of the two existing version candidates, and Decision D's own fallback plus its snapshot-required startup cost measured as a focused-read count per readiness.
- No sensitive mailbox data is emitted by the instrumentation.

## Phase 1: Remove measured redundant work

Apply independently shippable changes that the Phase 0 baseline proves relevant. Remeasure the affected flows after every item rather than batching all quick wins into one result.

1. Keep account progress out of the mailbox read. The existing account-sync SSE route sends an initial durable snapshot after connection, so make the stripe state an explicit `connecting`, `available`, or `unavailable` contract until that snapshot arrives. Never substitute zero progress (`apps/api/src/routes/account-sync-events.ts`).
2. Reduce the first thread page below 100 rows only if the baseline shows payload size, query time, rendering, or hydration cost warrants it (`packages/database/src/repositories.ts:101`). Record the chosen size and preserve cursor correctness and scroll behavior.
3. Remove the redundant `await connection()` from `apps/web/src/app/mail/page.tsx:68`, and remove any duplicate account read left in the broad workspace path.

Migrate infinite scrolling directly to the thread-only endpoint in Phase 4. Do not add an interim duplicate endpoint solely to land it in this phase.

Do not suppress the existing post-mutation canonical refresh in this phase. Replace its full-workspace read only after the focused thread-detail contract, repository operation, and endpoint exist. Temporary redundant work is safer than stale read state.

Opening an unread thread therefore continues to cost one navigation read plus one full workspace refresh until Phase 4 narrows that refresh to the focused detail resource. Record the measured interim cost from Phase 0 in this section so the acceptance stays explicit and dated rather than becoming invisible.

### Exit criteria

- Thread-list and thread-detail navigation do not wait on account progress reads.
- Sync and Memory progress render honest connecting, available, unavailable, complete, and failed states without synthetic values.
- If page size changes, pagination and infinite-scroll regression tests pass at the measured size.
- Canonical read-state convergence remains enabled until its focused replacement is complete, and its interim cost is recorded here.

## Phase 2: Split the shared contracts by resource

Replace the broad mailbox workspace contract with focused browser and server contracts in `packages/contracts`:

- `MailboxShell`: authorized account identity, sidebar label definitions, and stable configuration rendered by the shell. Counts and progress do not belong here.
- `MailboxSidebarCounts`: view and label counts, fetched and invalidated independently from the shell and center pane.
- `MailboxThreadPage`: threads and cursor pagination data for one view. Do not retain `totalThreadCount`; the current frontend does not consume it, and calculating it adds a view-wide aggregate.
- `MailboxThreadDetail`: one authorized thread, its messages, attachments, drafts, and labels.
- `MailboxSettings`: memories and settings, loaded only when the settings surface opens.

Model exact wire shapes and preserve the distinction between absent, unavailable, and empty data. If Decision C uses a resource version or correlation field, model it consistently in every affected read and event contract. Update every producer and consumer before removing the legacy contract; do not leave duplicate web-local types or permanent compatibility shims.

### Exit criteria

- All new contracts compile for browser and server consumers.
- Each contract contains only data required by its named resource. Only `MailboxSidebarCounts` carries aggregate-derived count fields, and no mailbox read contract carries progress.
- No contract duplicates exist between `apps/web` and `apps/api`.

## Phase 3: Create focused database read paths

Extract repository operations with one clear responsibility, following existing package naming and transaction conventions. Expected responsibilities include:

- `getMailboxAccountContext`
- `getMailboxShell`
- `listMailboxThreads`
- `getMailboxThreadDetail`
- `getMailboxSettings`
- `getMailboxSidebarCounts`

Every operation must scope reads by server-resolved `userId` and `accountId` before returning protected data. Give exported repository boundaries explicit input and return types.

The split must strengthen scoping rather than inherit it. The current label-membership and attachment reads are bounded only by an identifier list (`packages/database/src/repositories.ts:1502-1530`, `repositories.ts:1702`) and are safe only because that list came from an authorized query in the same function. As standalone operations they must carry explicit `userId` and `accountId` predicates.

Independent reads within one resource may run concurrently when that does not weaken transaction consistency. Avoid sequential query waterfalls and repeated lookups of the same account context within a request.

Required ownership boundaries:

- Opening a thread must not query the current thread list, sidebar counts, memories, or progress.
- Changing a sidebar view must not query messages, drafts, attachments, memories, or progress.
- Listing a mailbox view must not calculate a total thread count unless a real consumer and measured requirement are introduced.
- Opening settings must not require thread-detail data.

### Exit criteria

- Repository tests cover authorization scoping, cross-account isolation, and empty or unavailable states.
- Every extracted operation scopes by `userId` and `accountId` without relying on a caller-supplied identifier list for authorization.
- Query counts are recorded for shell, list, and detail reads independently.
- Each resource reads only the database records needed for its contract.

## Phase 4: Expose focused Fastify endpoints

Add focused API routes using the established Fastify authentication, authorization, validation, and problem-response patterns:

```text
GET /v1/mailbox/shell
GET /v1/mailbox/sidebar-counts
GET /v1/mailbox/threads?view=all&cursor=...
GET /v1/mailbox/threads/:threadId
GET /v1/mailbox/settings
```

The exact route organization should follow the closest existing mail route conventions. Validate view, cursor, and identifier inputs at the HTTP boundary. Resolve ownership on the server and never trust a client-asserted account owner.

Update infinite scrolling to request only the thread-list endpoint. The web application must continue using Axios for outbound application HTTP.

Move the minimum targeted-event work required by read-state convergence into this phase rather than depending on Phase 5:

- Keep every durable producer behind the typed `insertMailboxChange` boundary. Model semantic variants using `changeType` plus a required secondary discriminator such as `reason` or `kind`, including history catch-up versus message refresh, label-analysis resolution versus a manual label decision, and draft snapshot versus draft upsert or deletion.
- Normalize the two history variants only where they share a real invariant. Both must carry `changedThreadIds` and `refreshedThreadIds`; for `message_refresh`, the refreshed set contains the recorded thread. Only history catch-up carries `historyCursor` unless a canonical cursor is explicitly read and proved at the message-refresh boundary. This makes the coalesced-history trigger available without inventing a cursor.
- Replace `MailboxChangeEvent` with an exact browser-safe discriminated union produced by an explicit database-to-wire projection. Delete `repair_complete` from the browser contract, producer union, and schema check constraint unless a producer is introduced in the same slice; the constraint change needs a generated and inspected migration. Decision D's `mailbox_stream_ready` is a transport frame with its own SSE event name and must not be added to the durable `changeType` union or the check constraint, so it is outside the rule that every declared change type has a producer. Phase 4 may retain a typed coarse-invalidation wire member for non-history variants that Phase 5 has not mapped yet, so the product remains correct without pretending their affected resources are known.
- Extend the API event writer, which discards the payload today (`apps/api/src/routes/mailbox-events.ts:26-36`) although the repository already selects it (`replica.ts:959`). Validate the stored `jsonb` at the API boundary and serialize an explicit field allowlist. Provider identifiers such as the `providerMessageId` carried by `drafts_changed` (`replica.ts:417`, `replica.ts:443`) must be resolved to internal identifiers or omitted, never forwarded. A legacy or malformed stored payload becomes the typed safe-invalidation member; it is not silently dropped.
- Parse and validate the event again at the browser boundary. An unknown member or a missing required field invalidates all mailbox resource-cache entries and immediately revalidates only mounted resources, using the same safe path as Decision D rather than becoming a no-op.
- Dispatch history events according to the meaning of each set. Use `refreshedThreadIds` to revalidate an open matching thread detail, because the provider history ID may have advanced even when Gmail label memberships compare equal. Use `changedThreadIds` to invalidate cached thread-list rows and count resources whose stored presentation or membership may have changed. Every changed thread is already added to the refreshed set (`replica.ts:833`), so a real list change also revalidates an open detail.

Narrow the post-mutation canonical revalidation in this phase, which ends the interim full-workspace reload accepted in Phase 1. When an unread thread becomes canonically read, its changed membership revalidates the open thread detail and marks every cached list page containing that thread stale, because list rows render unread state from Gmail labels. If history is coalesced back to unread, the refreshed membership still revalidates detail so the advanced provider history ID remounts `ThreadReadTracker` and permits another read attempt. A hidden list page need not make an immediate request, but it must refetch before display. A canonical list response may patch a changed row instead, but the client must not infer provider success before the canonical event. This does not depend on Decision C: narrowing which resources an event affects is not the same as skipping canonical convergence.

Keep the existing full workspace endpoint only while consumers are being migrated. Remove the endpoint, serializer, service path, tests, and dead exports once the last consumer is gone.

### Exit criteria

- Endpoint tests cover authentication, ownership, invalid input, pagination, and stable failure responses.
- Thread detail cannot return data from another user or account.
- The thread-list response contains no message body, attachment, draft, memory, settings, or progress data, asserted by test rather than by review.
- The shell response contains no sidebar counts or progress, and the sidebar-count response contains no thread, message, memory, settings, or progress data.
- After a client-initiated read-state change, canonical convergence revalidates the focused thread detail and invalidates or canonically patches cached list pages containing the thread. It performs no full-workspace, sidebar-count, memory, settings, or progress read. A hidden stale list is refetched only before it is displayed. The interim full-workspace cost recorded in Phase 1 is retired here.
- Every durable event producer uses the shared insertion boundary and a closed typed variant with no optional-field ambiguity; a repository-wide search finds no product-code insert that bypasses it. Both history variants expose their proved changed and refreshed thread sets. The browser projection is validated at both the API and browser boundaries; non-history variants not yet targeted use an explicit coarse safe-invalidation member until Phase 5 replaces it.
- No browser event field carries a provider identifier, asserted by test on the serialized event.

## Phase 5: Replace blanket refreshes with targeted invalidation

This phase is sequenced before the shell change because its resolution constrains how shell resources are fetched. Phase 0 measurements may justify pulling individual invalidation changes earlier, but they must retain the same resource contracts and correctness rules.

Replace the typed coarse-invalidation members retained in Phase 4 with targeted browser projections for the remaining producer variants. Add the internal resource identifiers, affected view dimensions, and label dimensions required by those mutations, using the payload inventory recorded above (`packages/database/src/replica.ts:834-845`). Do not copy provider payloads into browser events. Keep event parsing exhaustive so an unknown or incomplete category follows the Decision D safe-invalidation path rather than being silently ignored.

Identifiers scope which resource to revalidate. They never authorize skipping a revalidation; only the proof selected in Decision C can do that. Phase 4 already narrowed read-state convergence to its affected resources. This phase completes resource mapping for the other event categories and determines whether any proved-current event may be skipped entirely.

Apply explicit invalidation rules:

- Revalidate or invalidate every affected resource after a canonical event unless the proof selected in Decision C establishes that each affected client resource is current.
- Refresh `MailboxShell` only when account configuration or sidebar label definitions change.
- Refresh thread detail when the currently open thread is in a history event's `refreshedThreadIds` or another event variant's proved affected-thread set.
- Invalidate a thread-list page when a changed thread is present and any displayed row field can change, including unread, starred, or label presentation. Also invalidate the list when the change can alter view membership or ordering, even if the thread is absent from the current page.
- Refresh the independent sidebar-counts resource only when a counted membership changed.
- Refresh draft state only for the affected thread or draft surface. `drafts_changed` carries no thread or Invook draft identifier today (`packages/database/src/replica.ts:365`, `replica.ts:417`, `replica.ts:443`), so this rule requires either a normalized producer payload carrying the affected internal identifiers or server-side resolution at the API boundary. Choose one in this phase and record it; do not state the rule without its input.
- Refresh settings or memories only when that resource is affected and its surface is open.
- Ignore events unrelated to the visible resources.

Six constraints make the middle rules harder than they appear, and the phase is not complete until all six are handled explicitly:

Decision B selected the documented coarse refresh fallback, so the requirements below that depend on independently addressable client cache entries are recorded as deferred rather than falsely claimed complete. The implemented dispatcher still ignores history and draft events that cannot affect the visible surface, uses changed versus refreshed thread sets for list versus open-detail relevance, and resolves every draft notification to internal thread identifiers. A relevant refresh re-runs only focused endpoints; it never calls a workspace endpoint. Labels conservatively refresh the mounted mail list because the current durable decision row does not prove which server-filtered view a thread entered or left.

- **View relevance is not derivable from thread identifiers alone.** A thread that changes its one Invook label may be absent from the client's current list, so the client cannot judge relevance. Either the event carries the affected view or label category, or the client asks the server whether a change intersects the visible view.
- **Counts change on nearly every applied history.** Counts therefore use the dedicated `MailboxSidebarCounts` resource and invalidation path introduced in Phases 2 through 4. A count change must not refetch `MailboxShell` or the center pane.
- **A newly eligible unassigned Inbox thread is absent from `changedThreadIds`.** Its message upsert queues thread analysis, so visibility is announced by the later `labels_changed` event from `thread-label-analysis.ts`. Map that event to the thread list explicitly; already-assigned threads remain in the normal history-change path.
- **A refreshed thread can require detail convergence even when `changedThreadIds` is empty.** A label refresh always advances `providerHistoryId` and adds a visible thread to `refreshedThreadIds`, even when the final Gmail label memberships equal the stored memberships (`packages/database/src/repositories.ts:2736-2749`, `packages/database/src/replica.ts:795-797`). Revalidate a matching open detail from the refreshed set so coalesced `UNREAD` removal and addition remounts the tracker and permits another canonical read attempt. Do not use the refreshed-only case to invalidate lists or counts whose rendered fields did not change.
- **A matching thread identifier does not prove a self-only event.** History catch-up can coalesce the client write with later provider changes. Apply Decision C and revalidate or invalidate every affected resource whenever current state is not proved.
- **Every new live stream has a synchronization gap, and so does every subscription interruption.** Implement Decision D's typed readiness event on initial connection, every reconnect, every notification-subscription re-establishment, and every dropped delivery. Invalidate every mailbox resource cache entry, revalidate mounted resources once with single-flight coalescing per resource, and leave hidden entries stale. Emit readiness only while a live subscription feeds the stream. Do not treat the existing timestamp-and-UUID replay anchor as proof of currency; targeted invalidation is incomplete while stream startup or a server-side subscription gap can leave a resource stale indefinitely.

Migrate the direct refresh call sites in the same phase: `draft-composer.tsx:60`, `draft-composer.tsx:82`, `draft-composer.tsx:99`, `smart-label-controls.tsx:32`, `mailbox-refresh-button.tsx:22`, `label-settings.tsx:43`, `label-settings.tsx:55`, `memory-settings.tsx:81`, `memory-settings.tsx:89`, `use-mailbox-events.ts:11-12`, and the memory-completion refresh in `use-account-sync-events.ts:31`. The settings sites matter as much as the mail sites, because the settings dialog renders inside `/mail`, so a label or memory write re-runs the whole workspace read. `sign-out-button.tsx:29` is out of scope: it refreshes an authentication transition, not mailbox data. An explicit user-triggered refresh may still refresh broadly, provided it is user-initiated.

Continue using provider webhooks, durable workflow state, and SSE. Do not add timers or polling.

### Exit criteria

- Tests cover affected and unrelated events for each visible resource, including a change that enters or leaves the visible view.
- A newly arrived message reaches the thread list through its `labels_changed` mapping, proved by a test that emits `history_applied` without the thread in `changedThreadIds`.
- Draft invalidation resolves an affected thread or draft surface from identifiers the event actually carries, and a `drafts_changed` event does not refresh the thread list or shell.
- An unrelated mailbox event causes no navigation refresh.
- A client-initiated mutation revalidates only its affected resources until Decision C proves that revalidation is redundant. Read-state convergence includes thread detail and any cached list page containing the thread.
- Any skipped self-event is covered by a test proving the selected Decision C invariant, including a coalesced external change case.
- Initial stream startup, automatic reconnect, subscriber remount, API restart, notification-subscription re-establishment with the browser stream still open, a dropped delivery, and an event concurrent with the readiness snapshot all converge through Decision D without leaving a stale resource. The clause forbidding a legacy full-workspace read holds unless Decision B recorded the coarse-refresh fallback, in which case Decision D records the coarse readiness refresh and this criterion is relaxed there rather than carried unmet.
- Under Decision B, remaining route refreshes are the explicit coarse fallback and can execute only focused endpoints; no legacy workspace read exists.

## Phase 6: Make the mail shell persistent

Implement the shell according to Decisions A, B, C, and D.

The shell owns only stable structure:

- Account and sidebar shell.
- Mail grid and pane structure.
- Stripe or account-status surface required across mail screens.
- Mailbox event subscriber.

The stable shell fetches only `MailboxShell`. A focused sidebar-counts component owns `MailboxSidebarCounts` and can revalidate it without refetching the account shell or center pane. The account-progress stripe owns the existing SSE snapshot and updates independently.

Splitting counts out has two accepted consequences that must be stated in the UI rather than left implicit: a view change can paint its thread list beside a count that has not yet updated, and counts can arrive after first paint. Both must render an explicit loading or unavailable state, never a zero. Put URL-derived active navigation state in a small, focused client component and isolate search-parameter hooks behind an appropriate Suspense boundary.

Each center-pane destination fetches only its resource:

- A thread destination fetches `MailboxThreadDetail`.
- A list destination fetches `MailboxThreadPage`.
- Compose does not fetch a thread list unless the UI actually renders one.
- Search uses its dedicated search result path, and does not serialize behind an unrelated read.
- Automations and settings do not trigger a general mailbox read.

Add center-pane loading and error boundaries using the mechanism Decision A selected, so the sidebar remains mounted and interactive during navigation. Keep dynamic rendering opt-outs at the narrowest leaf that requires them rather than forcing the shared shell to wait on every navigation.

Do not add shared private-data caching in this phase.

### Exit criteria

- Normal list and thread navigation preserves the mounted, interactive sidebar shell.
- Pending feedback appears within the measured interaction target.
- Each destination requests only its focused endpoint, verified by request log rather than by inspection.
- Decision B deletes the count-only request criterion for mailbox refreshes. Progress events still request no mailbox read resource, and counts remain a separate focused contract with an explicit unavailable state.
- A loading boundary actually renders for every navigation kind the product supports, including any driven by search parameters.
- Loading, error, empty, unavailable, and reconnect states remain explicit.

## Phase 7: Optimize SQL only where evidence requires it

Use the baseline and post-split `EXPLAIN (ANALYZE, BUFFERS)` results to select query changes. Candidate access patterns to evaluate include:

```text
threads(user_id, account_id, latest_message_at, id)
messages(thread_id, label_analysis_state)
label membership keys used by mailbox view filters
```

These are investigation candidates, not pre-approved schema changes. Confirm column order, selectivity, existing indexes, sort behavior, and write cost before adding any index.

Also evaluate:

- The two correlated `EXISTS` subqueries computed per thread row (`packages/database/src/repositories.ts:1300-1324`), and whether the same result can be produced once per page without changing semantics.
- The `countDistinct` sidebar-count queries (`repositories.ts:1378-1412`), whose cost grows with mailbox size.
- Any remaining aggregate that blocks the thread-list or thread-detail critical path.

Introduce a durable sidebar-count projection only if live counting remains a measured bottleneck after endpoint splitting and indexing. If introduced, it must have one canonical owner, transactional update rules, replay or repair behavior, and tests for concurrent mailbox changes.

### Exit criteria

- Every schema or query change is tied to measured evidence.
- Schema changes include generated and inspected migrations.
- A clean migration apply is verified when the required database is available.
- Write amplification and correctness tradeoffs are documented.

## Phase 8: Add private-data caching only if still necessary

Evaluate caching after Phase 1 cleanup, focused endpoints, targeted invalidation, the persistent shell, and measured SQL work are complete.

Any mailbox cache must be:

- Scoped by authenticated user and account.
- Invalidated by a durable version or resource tag derived from canonical changes.
- Private and never reusable across users.
- Limited to metadata needed by the target screen.
- Correct after process restart and SSE reconnect.

Do not cache message bodies or attachments speculatively. Do not use TTL timers as the correctness mechanism. Because `apps/web` is UI-only, it must not import database or provider packages to implement a cache. Avoid framework cache directives for cookie-scoped mailbox data until the cache key, authorization boundary, and invalidation contract are proved safe.

### Exit criteria

- Caching is added only when post-optimization measurements still miss the target.
- Authorization and invalidation tests cover cross-user isolation and stale-data recovery.
- Removing or bypassing the cache preserves correct behavior.

## Zustand decision

Zustand is not the solution to the current navigation delay because the delayed state is authoritative mailbox data fetched from the server. Moving it into a client store would introduce a second source of truth and additional synchronization work.

Zustand remains appropriate for feature-owned client UI state that genuinely crosses unrelated components, and for streamed progress that is already client-owned, as the existing account-sync store shows (`apps/web/src/stores/account-sync/store.ts`). Such a store follows the repository's typed initial-state, reset, and devtools conventions. This work must not create a mailbox-data store, and Decision B must not be resolved by adding one.

## Delivery sequence

Implement the plan in independently reviewable slices:

1. Add privacy-safe timing, record the untouched baseline in this document, and resolve Decisions A, B, C, and D.
2. Remove measured redundant work that is safe on the existing path: progress off navigation, evidence-gated progress-stream optimization, measured page-size excess, and the redundant dynamic opt-out. Remeasure after each change.
3. Add focused contracts, repositories, and endpoints, including the independent sidebar-counts resource, behind the existing UI.
4. Migrate thread lists and infinite scrolling.
5. Migrate thread detail; give every durable event producer a precise typed variant; expose history changed and refreshed thread sets through a validated browser-safe projection; and narrow canonical post-mutation convergence to detail plus affected cached list pages without suppressing it. Retain an explicit coarse safe-invalidation projection for event variants not yet mapped.
6. Replace the remaining coarse event projections with targeted internal-resource impacts, implement Decision D's gap-free snapshot-on-readiness protocol including subscription re-establishment and dropped-delivery readiness, retire the unsafe timestamp-and-UUID replay path together with its `id:` frames and `Last-Event-ID` validation unless a separate proved consumer requires it, and migrate every direct refresh call site.
7. Introduce the persistent mail shell, independent counts and progress owners, and destination-level loading boundaries.
8. Apply measured SQL improvements.
9. Evaluate private caching only if targets are still missed.
10. Remove the full workspace path and all dead symbols.

Each slice must preserve a working product state. The completed migration must not retain speculative compatibility routes or duplicate business rules.

## Verification plan

Automated coverage should include:

- Shared contract validation and serialization.
- User and account ownership for every focused endpoint and every extracted repository operation.
- Multi-account isolation.
- Thread-list filters, ordering, cursor pagination, empty pages, and the selected page size.
- Thread detail, drafts, attachments, and label associations.
- Targeted invalidation, including a change entering and leaving the visible view and a client-initiated mutation.
- Resource-version or mutation-correlation behavior selected by Decision C, including a coalesced history event containing both a client write and an external provider change.
- Exact producer variants discriminated by `changeType` plus their semantic `reason` or `kind`, one shared insertion boundary used by every product producer, API-boundary projection of only authorized fields, safe invalidation for a legacy or malformed stored payload, and proof that no browser event contains a provider identifier.
- Detail revalidation for a `history_applied` event whose `changedThreadIds` is empty and `refreshedThreadIds` contains the open thread, plus list invalidation for a newly arrived message announced only by `labels_changed`.
- Read-state convergence updates the open detail and makes every cached list containing that thread current before display, without a full-workspace refresh.
- Decision D's delivery cases: the initial read-to-subscribe race, automatic reconnect, subscriber remount, API restart, an event committed immediately before registration, an event concurrent with the focused snapshot, and an unknown payload that requires the same safe path. Assert that readiness is emitted only after live registration, mounted resources are revalidated once, and hidden cache entries are stale before display.
- Decision D's server-side gap cases: connection-level listener loss, notification-subscription re-establishment, a lookup failure scoped by the notification's validated internal user/account identifiers, a malformed or mismatched notification requiring the broad fallback, and a process holding no subscription. Assert that none emits readiness until subscription and canonical user/account recovery both succeed.
- Absence of SSE `id:` frames, `Last-Event-ID` forwarding and validation, and timestamp-and-UUID replay; every reconnect converges through readiness instead.
- Absence assertions on response shape, so a focused endpoint cannot regrow body, attachment, memory, settings, or progress fields.
- Loading, empty, connecting, unavailable, and error UI states for shell, counts, progress, list, and detail resources.
- Regression coverage for read-state changes while a thread is open.

Run the narrowest relevant tests during each slice, followed by the repository gate when the complete change warrants it:

```bash
make verify
```

Run Docker Compose validation if container configuration changes. Run migration checks when the database schema changes. If a required external service or `TEST_DATABASE_URL` is unavailable, report exactly which integration verification was skipped.

Perform real browser measurements against a connected mailbox after each measurable slice, not only at the end. Compare before and after p50, p95, the threshold-exceedance rate, the worst recorded sample, query counts, payload sizes at both hops, and visible pending-state time for the same flows and mailbox, using the same harness. Use p95 and the recorded exceedance-rate budget as acceptance gates, applying a 1% budget only to a flow with at least 1000 recorded samples and the 5% budget otherwise. Report p99 and the maximum for diagnosis only; report p99 only from a recorded set of at least 1000 completed samples.

Before handoff, search repository-wide for the removed workspace contract, endpoint, service, serializers, and unused exports. Also confirm the work introduced no forbidden polling, native application `fetch`, or duplicated mailbox state.

## Definition of done

This performance work is complete when:

- The measured targets recorded in Phase 0 are met, or a measured external constraint and follow-up are documented here.
- No frontend consumer requests the full mailbox workspace for ordinary list or thread navigation.
- No thread-list or thread-detail navigation waits on an aggregate whose cost grows with total mailbox size. Independently loaded sidebar counts and account progress meet their recorded budgets. If the progress aggregate exceeded its budget, the verified durable projection replaces it; otherwise its execution frequency does not exceed the accepted Phase 0 rate.
- Opening a thread performs one bounded detail read for navigation and does not load unrelated lists, counts, memories, settings, or progress. A later canonical read-state change revalidates detail and invalidates or canonically patches cached list pages containing that thread, without a full-workspace refresh.
- Changing a sidebar view does not load thread messages, drafts, or attachments.
- Unrelated events do not refresh the visible route. A self-correlated event is skipped only when the proof selected in Decision C establishes that every affected client resource is current.
- Every mailbox event producer uses a precise discriminated variant, the browser projection exposes no provider identifier, malformed or legacy payloads converge through safe invalidation, and no declared durable change type lacks a producer. Decision D's readiness frame is transport state and is excluded from that rule and from the `change_type` constraint.
- Stream startup, every reconnect path, and every notification-subscription interruption are gap-free: a focused readiness snapshot makes mounted resources current and hidden resources stale before display, without polling and without a stale replay anchor. The clause excluding a legacy full-workspace read holds unless Decision B recorded the coarse-refresh fallback, in which case Decision D records the coarse readiness refresh it accepts instead.
- Gmail and PostgreSQL authority remain intact without optimistic provider state.
- Authorization, pagination, reconnect, and read-state regressions are covered.
- Required checks pass, and any unavailable external verification is reported accurately.
