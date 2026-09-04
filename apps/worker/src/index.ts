/**
 * Worker process entry point. Owns only process lifecycle: it opens the
 * Temporal connection, ensures a Worker per active tenant, and drains the
 * command outbox. All executable work lives under ./activities.
 */
import {
  deleteExpiredLabelPreviewReceipts,
  ensureDailyGmailWatchRenewals,
  enqueuePendingAnalysisWorkflowSteps,
  enqueueHistoricalThreadLabelBatchRecoveries,
  enqueueRecentThreadLabelRecoveries,
  enqueueMissingMailSyncRuns,
  enqueueImplausibleGmailMessageDateRepairs,
  enqueueFailedInitialGmailRepairRecoveries,
  enqueuePendingGmailHistoryCatchups,
  enqueuePostSyncWorkflowSteps,
  listenForTemporalCommandNotifications,
  listActiveTemporalTenantIds,
  dispatchTemporalCommandBatch,
} from "@invook/database";
import { GMAIL_MESSAGE_FUTURE_TOLERANCE_MS } from "@invook/gmail";

import { TemporalRuntime } from "./temporal/runtime";
import { terminateWorkerAfterFatalError } from "./temporal/process-lifecycle";

import {
  catchUpGmailHistoryActivity,
  finalizeGmailSyncActivity,
  ingestGmailThreadBatchActivity,
  syncGmailThreadPageActivity,
} from "./activities/gmail/sync";
import {
  failHistoricalLabelScanActivity,
  finalizeHistoricalLabelBatchActivity,
  submitHistoricalLabelBatchActivity,
} from "./activities/label/batch";
import { scanThreadLabelPageActivity } from "./activities/label/analysis";
import {
  reconcileWorkflowStepFailureActivity,
  runWorkflowStepActivity,
} from "./activities/registry";

function createJobSignal() {
  let pending = false;
  let release: (() => void) | null = null;

  return {
    notify() {
      pending = true;
      if (release) {
        const currentRelease = release;
        release = null;
        currentRelease();
      }
    },
    wait() {
      if (pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        release = () => {
          pending = false;
          resolve();
        };
      });
    },
  };
}

async function runTemporalCommandLoop(
  signal: ReturnType<typeof createJobSignal>,
  isStopped: () => boolean,
  runtime: TemporalRuntime,
) {
  while (!isStopped()) {
    await signal.wait();
    if (isStopped()) break;
    await runtime.ensureTenantWorkers(await listActiveTemporalTenantIds());
    while (!isStopped()) {
      const result = await dispatchTemporalCommandBatch((jobs) =>
        runtime.dispatch(jobs),
      );
      if (result.failed) {
        throw new Error("Temporal command dispatch failed.");
      }
      if (result.dispatched === 0) break;
    }
  }
}

async function run() {
  const runtime = await TemporalRuntime.create({
    activities: {
      runWorkflowStepActivity,
      reconcileWorkflowStepFailureActivity,
      syncGmailThreadPageActivity,
      ingestGmailThreadBatchActivity,
      finalizeGmailSyncActivity,
      catchUpGmailHistoryActivity,
      scanThreadLabelPageActivity,
      submitHistoricalLabelBatchActivity,
      finalizeHistoricalLabelBatchActivity,
      failHistoricalLabelScanActivity,
    },
  });
  const outboxSignal = createJobSignal();
  let stopRequested = false;
  let fatalError: Error | null = null;
  const requestStop = () => {
    stopRequested = true;
    outboxSignal.notify();
  };
  const workerRun = runtime.run().catch((error: unknown) => {
    fatalError =
      error instanceof Error ? error : new Error("Unknown Temporal worker error.");
    requestStop();
  });
  const stopOutboxListening = await listenForTemporalCommandNotifications({
    onEntryAvailable: outboxSignal.notify,
    onSubscriptionLost: () => {
      fatalError ??= new Error(
        "The Temporal command notification subscription was lost.",
      );
      requestStop();
    },
  });

  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    const deletedPreviewReceiptCount =
      await deleteExpiredLabelPreviewReceipts();
    if (deletedPreviewReceiptCount > 0) {
      console.info("worker: expired label preview receipts deleted", {
        count: deletedPreviewReceiptCount,
      });
    }
    await enqueueImplausibleGmailMessageDateRepairs({
      latestAllowedAt: new Date(
        Date.now() + GMAIL_MESSAGE_FUTURE_TOLERANCE_MS,
      ),
    });
    await enqueueMissingMailSyncRuns();
    await enqueueFailedInitialGmailRepairRecoveries();
    await enqueuePendingGmailHistoryCatchups();
    await ensureDailyGmailWatchRenewals();
    await enqueuePostSyncWorkflowSteps();
    await enqueueHistoricalThreadLabelBatchRecoveries();
    await enqueueRecentThreadLabelRecoveries();
    await enqueuePendingAnalysisWorkflowSteps();
    outboxSignal.notify();
    await runTemporalCommandLoop(outboxSignal, () => stopRequested, runtime);
    if (fatalError) throw fatalError;
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await stopOutboxListening();
    await runtime.close();
    await workerRun;
  }
}

run().catch(terminateWorkerAfterFatalError);
