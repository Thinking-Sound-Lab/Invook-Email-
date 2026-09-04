import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import {
  gmailIncrementalSyncCatchUpsPerExecution,
  gmailIncrementalSyncIdleTimeout,
  type GmailIncrementalSyncActivities,
  type GmailIncrementalSyncState,
  type GmailIncrementalSyncWorkflowInput,
  type GmailIncrementalSyncWorkflowResult,
} from "../contracts/gmail-incremental-sync";

/** Every live trigger for an account carries no payload: the cursor is the state. */
export const gmailCatchUpSignal = defineSignal("gmailCatchUp");

/** Sent when an account is disconnected, so the entity stops rather than idling. */
export const gmailAccountDisconnectedSignal = defineSignal(
  "gmailAccountDisconnected",
);

export const gmailIncrementalSyncStateQuery =
  defineQuery<GmailIncrementalSyncState>("gmailIncrementalSyncState");

const catchUpActivityOptions = {
  startToCloseTimeout: "15 minutes",
  scheduleToCloseTimeout: "2 hours",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
  },
} as const;

/**
 * Keeps one account's replica current with Gmail.
 *
 * Triggers coalesce by construction. A signal only records that something
 * changed; the catch-up that follows reads the account's cursor and applies
 * everything since, so ten notifications arriving during one catch-up cost one
 * more catch-up rather than ten.
 */
export async function gmailIncrementalSyncWorkflow(
  input: GmailIncrementalSyncWorkflowInput,
): Promise<GmailIncrementalSyncWorkflowResult> {
  const { catchUpGmailHistoryActivity } =
    proxyActivities<GmailIncrementalSyncActivities>({
      ...catchUpActivityOptions,
      taskQueue: input.activityTaskQueue,
    });

  let pendingRequestCount = input.pendingRequestCount;
  let catchUpsCompleted = input.catchUpsCompleted;
  let catchUpsThisExecution = 0;
  let historyCursor: string | null = null;
  let isDisconnected = false;

  setHandler(gmailCatchUpSignal, () => {
    pendingRequestCount += 1;
  });
  setHandler(gmailAccountDisconnectedSignal, () => {
    isDisconnected = true;
  });
  setHandler(gmailIncrementalSyncStateQuery, () => ({
    pendingRequestCount,
    catchUpsCompleted,
    historyCursor,
  }));

  const close = (
    status: GmailIncrementalSyncWorkflowResult["status"],
  ): GmailIncrementalSyncWorkflowResult => ({
    status,
    accountId: input.accountId,
    catchUpsCompleted,
  });

  for (;;) {
    const isTriggered = await condition(
      () => pendingRequestCount > 0 || isDisconnected,
      gmailIncrementalSyncIdleTimeout,
    );
    if (isDisconnected) return close("disconnected");
    if (!isTriggered) return close("idle");

    // Cleared before the catch-up, not after: a signal that arrives while the
    // Activity runs describes history the Activity has not read yet and must
    // schedule another pass.
    pendingRequestCount = 0;
    const outcome = await catchUpGmailHistoryActivity({
      userId: input.userId,
      accountId: input.accountId,
    });
    catchUpsCompleted += 1;
    catchUpsThisExecution += 1;

    if (outcome.status === "disconnected") return close("disconnected");
    if (outcome.status === "repair_started") return close("repairing");
    if (outcome.status === "applied") {
      historyCursor = outcome.historyCursor;
      // Gmail capped the range, so the rest is still waiting behind the cursor.
      if (outcome.hasPendingHistory) pendingRequestCount += 1;
    }

    if (catchUpsThisExecution >= gmailIncrementalSyncCatchUpsPerExecution) {
      await continueAsNew<typeof gmailIncrementalSyncWorkflow>({
        userId: input.userId,
        accountId: input.accountId,
        activityTaskQueue: input.activityTaskQueue,
        pendingRequestCount,
        catchUpsCompleted,
      });
    }
  }
}
