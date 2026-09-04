import {
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import {
  threadLabelScanPagesPerExecution,
  type ThreadLabelScanActivities,
  type ThreadLabelScanWorkflowInput,
  type ThreadLabelScanWorkflowResult,
} from "../contracts/thread-label-scan";

/**
 * Asks for another pass. Sent while a scan is already running it is coalesced
 * into exactly one extra pass, however many times it arrives.
 */
export const threadLabelRescanSignal = defineSignal("threadLabelRescan");

const scanActivityOptions = {
  startToCloseTimeout: "5 minutes",
  scheduleToCloseTimeout: "1 hour",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
  },
} as const;

/**
 * Walks an account's threads in ID order, reserving each one that is still owed
 * an automatic label.
 *
 * The reference time is frozen for a pass so a thread cannot become ineligible
 * halfway through the walk. A pass that was asked to rescan restarts from the
 * first thread with a fresh reference time, because threads that arrived during
 * the walk can sort before the cursor and would otherwise be skipped.
 */
export async function threadLabelScanWorkflow(
  input: ThreadLabelScanWorkflowInput,
): Promise<ThreadLabelScanWorkflowResult> {
  const { scanThreadLabelPageActivity } =
    proxyActivities<ThreadLabelScanActivities>({
      ...scanActivityOptions,
      taskQueue: input.activityTaskQueue,
    });

  let isRescanRequested = input.isRescanRequested;
  setHandler(threadLabelRescanSignal, () => {
    isRescanRequested = true;
  });

  // Workflow time is deterministic, so freezing it here replays identically.
  let referenceAt = input.referenceAt ?? new Date().toISOString();
  let cursorThreadId = input.cursorThreadId;
  let pagesCompleted = input.pagesCompleted;
  let reservedThreadCount = input.reservedThreadCount;
  let passesCompleted = 0;
  let pagesThisExecution = 0;

  for (;;) {
    const page = await scanThreadLabelPageActivity({
      userId: input.userId,
      accountId: input.accountId,
      referenceAt,
      cursorThreadId,
    });
    pagesCompleted += 1;
    pagesThisExecution += 1;
    reservedThreadCount += page.reservedThreadCount;

    if (page.nextCursorThreadId === null) {
      passesCompleted += 1;
      if (!isRescanRequested) {
        return {
          accountId: input.accountId,
          pagesCompleted,
          reservedThreadCount,
          passesCompleted,
        };
      }
      isRescanRequested = false;
      cursorThreadId = null;
      referenceAt = new Date().toISOString();
    } else {
      cursorThreadId = page.nextCursorThreadId;
    }

    if (pagesThisExecution >= threadLabelScanPagesPerExecution) {
      await continueAsNew<typeof threadLabelScanWorkflow>({
        userId: input.userId,
        accountId: input.accountId,
        activityTaskQueue: input.activityTaskQueue,
        referenceAt,
        cursorThreadId,
        pagesCompleted,
        reservedThreadCount,
        isRescanRequested,
      });
    }
  }
}
