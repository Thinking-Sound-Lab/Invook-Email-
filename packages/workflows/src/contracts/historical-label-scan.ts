/**
 * Contract for a user-requested historical labelling scan.
 *
 * A scan is a sequence of provider Batches, each of which Invook submits and
 * then waits on for up to a day. The wait is the reason this is a Workflow: an
 * Activity cannot hold a 24-hour completion window, but a durable timer can.
 */

/**
 * Batches submitted in one Workflow Execution before Continue-As-New.
 *
 * A Batch costs roughly ten history events across submission, the completion
 * wait, and finalization, so this stays far inside the working target while
 * covering a scan of any realistic mailbox.
 */
export const historicalLabelScanBatchesPerExecution = 100;

/**
 * How long to wait on a provider Batch before reading its state directly.
 *
 * OpenAI's completion window is 24 hours, so the extra slack distinguishes a
 * Batch that is merely slow from a completion webhook that never arrived. The
 * wait is a Temporal durable timer, and expiry reconciles against the provider
 * rather than assuming failure.
 */
export const historicalLabelScanCompletionTimeout = "30 hours";

/** Retry pages a failing scope may take before the scan is marked failed. */
export const historicalLabelScanRetryLimit = 6;

export interface HistoricalLabelScanBatchScope {
  retryAttempt: number;
  /** Null on the opening Batch, where the Activity selects the candidates. */
  threadIds: string[] | null;
  continuations: HistoricalLabelScanContinuation[];
  /** Backoff before resubmitting after a retryable provider failure. */
  retryDelayMs: number;
}

export interface HistoricalLabelScanContinuation {
  retryAttempt: number;
  threadIds: string[];
}

export interface HistoricalLabelScanWorkflowInput {
  userId: string;
  accountId: string;
  historicalScanId: string;
  activityTaskQueue: string;
  scope: HistoricalLabelScanBatchScope;
  batchesCompleted: number;
  appliedThreadCount: number;
}

export interface SubmitHistoricalLabelBatchInput {
  userId: string;
  accountId: string;
  historicalScanId: string;
  retryAttempt: number;
  threadIds: string[] | null;
  continuations: HistoricalLabelScanContinuation[];
}

/**
 * `skipped` means the scope produced no Batch — every candidate fell away
 * before reaching the provider — so the scan advances without a completion
 * wait. `exhausted` means no thread was left at all, which ends the scan
 * normally. `superseded` means the scan is no longer the account's active one.
 */
export type SubmitHistoricalLabelBatchOutcome =
  | {
      status: "submitted";
      submissionId: string;
      providerBatchId: string;
      requestCount: number;
    }
  | { status: "skipped"; nextScope: HistoricalLabelScanBatchScope }
  | { status: "exhausted" }
  | { status: "superseded" };

export interface FinalizeHistoricalLabelBatchInput {
  historicalScanId: string;
  submissionId: string;
  providerBatchId: string;
}

/**
 * `pending` is only reachable after the completion wait expires and the
 * provider reports the Batch still running, so the Workflow waits again rather
 * than discarding a Batch that is merely slow.
 */
export type FinalizeHistoricalLabelBatchOutcome =
  | {
      status: "finalized";
      appliedThreadCount: number;
      /** Null when the scan has no further Batch to submit. */
      nextScope: HistoricalLabelScanBatchScope | null;
    }
  | { status: "pending" };

export interface FailHistoricalLabelScanInput {
  historicalScanId: string;
  errorCode: string;
}

export interface HistoricalLabelScanActivities {
  failHistoricalLabelScanActivity(
    input: FailHistoricalLabelScanInput,
  ): Promise<void>;
  submitHistoricalLabelBatchActivity(
    input: SubmitHistoricalLabelBatchInput,
  ): Promise<SubmitHistoricalLabelBatchOutcome>;
  finalizeHistoricalLabelBatchActivity(
    input: FinalizeHistoricalLabelBatchInput,
  ): Promise<FinalizeHistoricalLabelBatchOutcome>;
}

export type HistoricalLabelScanStatus =
  | "complete"
  | "exhausted"
  | "superseded"
  | "failed";

export interface HistoricalLabelScanWorkflowResult {
  status: HistoricalLabelScanStatus;
  historicalScanId: string;
  batchesCompleted: number;
  appliedThreadCount: number;
}
