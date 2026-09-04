/**
 * Contract for the durable Gmail synchronization run.
 *
 * The Workflow carries only the provider cursor, the thread identifiers it has
 * discovered, and the counters it reports. Thread content, credentials, and
 * replica state stay in PostgreSQL, so an Activity re-reads canonical state on
 * every attempt.
 */

/**
 * Threads ingested by a single Activity. Gmail is fetched thread by thread, so
 * the batch bounds both provider concurrency and the Workflow's history growth:
 * a 500-thread page becomes 50 Activities rather than 500.
 */
export const gmailSyncThreadBatchSize = 10;

/**
 * Pages retained in one Workflow Execution before Continue-As-New.
 *
 * A full page costs roughly 153 history events: three for the discovery
 * Activity plus three for each of the 50 thread batches it produces. Twelve
 * pages holds the Execution near the 2,000-event working target, far below the
 * 50,000-event hard limit. The count is explicit rather than driven by
 * `continueAsNewSuggested` because that hint is set by the server and fires
 * well above the target.
 */
export const gmailSyncPagesPerExecution = 12;

export interface GmailSyncWorkflowInput {
  userId: string;
  accountId: string;
  runId: string;
  /**
   * Where this run's Activities execute. Workflow Tasks are served by the
   * control lane, so the queue must be named explicitly to keep mailbox
   * ingestion off it.
   */
  activityTaskQueue: string;
  /** 1-based, and stable across Continue-As-New so persisted pages stay addressable. */
  pageNumber: number;
  /** Opaque Gmail cursor. Null starts at the newest thread. */
  pageToken: string | null;
  pagesCompleted: number;
  threadsDiscovered: number;
  threadsIngested: number;
}

/**
 * `superseded` means the run is no longer the active one for the account. It is
 * a terminal, non-retryable outcome: another run has taken ownership, so the
 * Workflow stops rather than competing with it.
 */
export type GmailSyncPageOutcome =
  | {
      status: "recorded";
      nextPageToken: string | null;
      /**
       * Threads this page contributed that no earlier page had already claimed.
       * Gmail can repeat a thread across pages when the mailbox changes mid-walk.
       */
      pendingThreadIds: string[];
    }
  | { status: "superseded" };

export interface GmailSyncPageInput {
  userId: string;
  accountId: string;
  runId: string;
  pageNumber: number;
  pageToken: string | null;
}

export interface GmailSyncThreadBatchInput {
  userId: string;
  accountId: string;
  runId: string;
  providerThreadIds: string[];
}

export type GmailSyncThreadBatchOutcome =
  | { status: "ingested"; ingestedThreadCount: number }
  | { status: "superseded" };

export interface GmailSyncFinalizeInput {
  userId: string;
  accountId: string;
  runId: string;
}

export type GmailSyncFinalizeOutcome =
  | { status: "ready"; historyCursor: string }
  | { status: "superseded" };

export interface GmailSyncActivities {
  syncGmailThreadPageActivity(
    input: GmailSyncPageInput,
  ): Promise<GmailSyncPageOutcome>;
  ingestGmailThreadBatchActivity(
    input: GmailSyncThreadBatchInput,
  ): Promise<GmailSyncThreadBatchOutcome>;
  finalizeGmailSyncActivity(
    input: GmailSyncFinalizeInput,
  ): Promise<GmailSyncFinalizeOutcome>;
}

export interface GmailSyncWorkflowResult {
  status: "ready" | "superseded";
  runId: string;
  pagesCompleted: number;
  threadsDiscovered: number;
  threadsIngested: number;
}
