/**
 * Contract for the per-account incremental synchronization entity.
 *
 * One Execution owns an account's live mailbox updates. Every trigger — a Gmail
 * push notification, a manual refresh, a write Invook itself made — is the same
 * signal, because Gmail history is a cursor rather than a queue: a single
 * catch-up drains everything that arrived while the previous one ran.
 */

/**
 * Catch-ups performed in one Execution before Continue-As-New.
 *
 * Each catch-up costs roughly five history events, so this holds an Execution
 * near the 2,000-event working target even for a mailbox that never goes quiet.
 */
export const gmailIncrementalSyncCatchUpsPerExecution = 200;

/**
 * How long an Execution waits for a signal before closing.
 *
 * The entity is recreated by `signalWithStart` on the next trigger, so exiting
 * costs nothing and keeps idle accounts from holding an open Execution. This is
 * a Temporal durable timer, not process-local polling.
 */
export const gmailIncrementalSyncIdleTimeout = "12 hours";

export interface GmailIncrementalSyncWorkflowInput {
  userId: string;
  accountId: string;
  /**
   * Where catch-up Activities execute. Workflow Tasks are served by the control
   * lane, so the queue is named rather than inherited.
   */
  activityTaskQueue: string;
  /** Carried across Continue-As-New so a signal is never dropped at the boundary. */
  pendingRequestCount: number;
  catchUpsCompleted: number;
}

export interface GmailCatchUpInput {
  userId: string;
  accountId: string;
}

/**
 * `deferred` means the replica is not ready, so the cursor stays pending and
 * the synchronization run will drain it. `superseded` means another catch-up
 * already applied the range. Neither is an error.
 */
export type GmailCatchUpOutcome =
  | {
      status: "applied";
      historyCursor: string;
      /** Gmail returned more history than one range could apply. */
      hasPendingHistory: boolean;
      changedThreadCount: number;
    }
  | { status: "deferred" }
  | { status: "repair_started"; runId: string }
  | { status: "superseded" }
  | { status: "disconnected" };

export interface GmailIncrementalSyncActivities {
  catchUpGmailHistoryActivity(
    input: GmailCatchUpInput,
  ): Promise<GmailCatchUpOutcome>;
}

export type GmailIncrementalSyncStatus =
  | "idle"
  | "disconnected"
  | "repairing";

export interface GmailIncrementalSyncWorkflowResult {
  status: GmailIncrementalSyncStatus;
  accountId: string;
  catchUpsCompleted: number;
}

export interface GmailIncrementalSyncState {
  pendingRequestCount: number;
  catchUpsCompleted: number;
  historyCursor: string | null;
}
