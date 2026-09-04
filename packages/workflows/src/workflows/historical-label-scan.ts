import {
  condition,
  continueAsNew,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";

import {
  historicalLabelScanBatchesPerExecution,
  historicalLabelScanCompletionTimeout,
  type HistoricalLabelScanActivities,
  type HistoricalLabelScanBatchScope,
  type HistoricalLabelScanWorkflowInput,
  type HistoricalLabelScanWorkflowResult,
} from "../contracts/historical-label-scan";

/**
 * Delivered when the provider reports a Batch terminal. The Batch ID is carried
 * so a webhook for a Batch this Execution has already finalized is ignored
 * rather than releasing the wait for the current one.
 */
export const historicalLabelBatchCompletedSignal = defineSignal<[string]>(
  "historicalLabelBatchCompleted",
);

const submitActivityOptions = {
  startToCloseTimeout: "15 minutes",
  scheduleToCloseTimeout: "4 hours",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
  },
} as const;

/**
 * Recording a scan's failure must itself survive, so it retries longer than the
 * work whose failure it reports.
 */
const failureActivityOptions = {
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "1 hour",
  retry: {
    initialInterval: "2 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
  },
} as const;

const finalizeActivityOptions = {
  startToCloseTimeout: "30 minutes",
  scheduleToCloseTimeout: "6 hours",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
  },
} as const;

/**
 * Runs one historical labelling scan to the end of its mailbox.
 *
 * Each pass submits a provider Batch and then waits: the provider takes up to a
 * day, and a completion webhook releases the wait. If the webhook never
 * arrives, the wait expires and the scan reads the Batch state directly, so a
 * lost webhook costs latency rather than a stalled scan.
 */
export async function historicalLabelScanWorkflow(
  input: HistoricalLabelScanWorkflowInput,
): Promise<HistoricalLabelScanWorkflowResult> {
  const { submitHistoricalLabelBatchActivity } =
    proxyActivities<HistoricalLabelScanActivities>({
      ...submitActivityOptions,
      taskQueue: input.activityTaskQueue,
    });
  const { finalizeHistoricalLabelBatchActivity } =
    proxyActivities<HistoricalLabelScanActivities>({
      ...finalizeActivityOptions,
      taskQueue: input.activityTaskQueue,
    });
  const { failHistoricalLabelScanActivity } =
    proxyActivities<HistoricalLabelScanActivities>({
      ...failureActivityOptions,
      taskQueue: input.activityTaskQueue,
    });

  const completedProviderBatchIds = new Set<string>();
  setHandler(historicalLabelBatchCompletedSignal, (providerBatchId) => {
    completedProviderBatchIds.add(providerBatchId);
  });

  let scope: HistoricalLabelScanBatchScope = input.scope;
  let batchesCompleted = input.batchesCompleted;
  let appliedThreadCount = input.appliedThreadCount;
  let batchesThisExecution = 0;

  const close = (
    status: HistoricalLabelScanWorkflowResult["status"],
  ): HistoricalLabelScanWorkflowResult => ({
    status,
    historicalScanId: input.historicalScanId,
    batchesCompleted,
    appliedThreadCount,
  });

  const fail = async (
    error: unknown,
  ): Promise<HistoricalLabelScanWorkflowResult> => {
    // A scan the Workflow cannot advance must say so, rather than sitting in
    // `running` until someone notices.
    await failHistoricalLabelScanActivity({
      historicalScanId: input.historicalScanId,
      errorCode:
        error instanceof Error
          ? error.message
          : "historical_label_scan_failed",
    });
    return close("failed");
  };

  for (;;) {
    // A retryable provider failure asked for backoff before the next attempt.
    if (scope.retryDelayMs > 0) await sleep(scope.retryDelayMs);

    let submitted;
    try {
      submitted = await submitHistoricalLabelBatchActivity({
        userId: input.userId,
        accountId: input.accountId,
        historicalScanId: input.historicalScanId,
        retryAttempt: scope.retryAttempt,
        threadIds: scope.threadIds,
        continuations: scope.continuations,
      });
    } catch (error) {
      return fail(error);
    }
    if (submitted.status === "exhausted") return close("exhausted");
    if (submitted.status === "superseded") return close("superseded");
    // Nothing reached the provider, so there is no completion to wait for.
    // The attempt still counts against the budget: a long run of empty scopes
    // must not grow history without bound.
    if (submitted.status === "skipped") {
      scope = submitted.nextScope;
      batchesThisExecution += 1;
      if (batchesThisExecution >= historicalLabelScanBatchesPerExecution) {
        await continueAsNew<typeof historicalLabelScanWorkflow>({
          userId: input.userId,
          accountId: input.accountId,
          historicalScanId: input.historicalScanId,
          activityTaskQueue: input.activityTaskQueue,
          scope,
          batchesCompleted,
          appliedThreadCount,
        });
      }
      continue;
    }

    const inFlight = submitted;
    let finalized;
    try {
      finalized = await (async () => {
        for (;;) {
          await condition(
            () => completedProviderBatchIds.has(inFlight.providerBatchId),
            historicalLabelScanCompletionTimeout,
          );
          const outcome = await finalizeHistoricalLabelBatchActivity({
            historicalScanId: input.historicalScanId,
            submissionId: inFlight.submissionId,
            providerBatchId: inFlight.providerBatchId,
          });
          // The wait expired on a Batch the provider is still running, so wait
          // again rather than abandoning work the provider will still deliver.
          if (outcome.status === "finalized") return outcome;
        }
      })();
    } catch (error) {
      return fail(error);
    }

    completedProviderBatchIds.delete(inFlight.providerBatchId);
    batchesCompleted += 1;
    batchesThisExecution += 1;
    appliedThreadCount += finalized.appliedThreadCount;

    if (finalized.nextScope === null) return close("complete");
    scope = finalized.nextScope;

    if (batchesThisExecution >= historicalLabelScanBatchesPerExecution) {
      await continueAsNew<typeof historicalLabelScanWorkflow>({
        userId: input.userId,
        accountId: input.accountId,
        historicalScanId: input.historicalScanId,
        activityTaskQueue: input.activityTaskQueue,
        scope,
        batchesCompleted,
        appliedThreadCount,
      });
    }
  }
}
