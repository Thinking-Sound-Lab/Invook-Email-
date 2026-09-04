/**
 * Contract for the per-account scan that finds threads still owed an automatic
 * label.
 *
 * The scan discovers and reserves work; it does not classify. Each reserved
 * thread becomes its own durable analysis, because a model call per thread is
 * exactly the unit Temporal already retries well.
 */

/**
 * Pages walked in one Workflow Execution before Continue-As-New.
 *
 * A page is one Activity, so three history events. Three hundred pages holds
 * the Execution near the 2,000-event working target while covering 30,000
 * threads at a hundred threads a page.
 */
export const threadLabelScanPagesPerExecution = 300;

export interface ThreadLabelScanWorkflowInput {
  userId: string;
  accountId: string;
  activityTaskQueue: string;
  /**
   * Frozen for the whole pass so eligibility cannot drift mid-scan. Null on the
   * first Execution, where the Workflow freezes its own deterministic time.
   */
  referenceAt: string | null;
  /** Exclusive lower bound on thread ID; null starts at the first thread. */
  cursorThreadId: string | null;
  pagesCompleted: number;
  reservedThreadCount: number;
  /** Carried across Continue-As-New so a rescan is never dropped at the boundary. */
  isRescanRequested: boolean;
}

export interface ThreadLabelScanPageInput {
  userId: string;
  accountId: string;
  referenceAt: string;
  cursorThreadId: string | null;
}

export interface ThreadLabelScanPageOutcome {
  /** Threads this page moved from pending to running and handed to an analysis. */
  reservedThreadCount: number;
  /** Null once the account has no thread past the cursor. */
  nextCursorThreadId: string | null;
}

export interface ThreadLabelScanActivities {
  scanThreadLabelPageActivity(
    input: ThreadLabelScanPageInput,
  ): Promise<ThreadLabelScanPageOutcome>;
}

export interface ThreadLabelScanWorkflowResult {
  accountId: string;
  pagesCompleted: number;
  reservedThreadCount: number;
  passesCompleted: number;
}
