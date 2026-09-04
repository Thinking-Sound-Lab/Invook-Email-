/**
 * Maps a durable step to its handler and adapts it to the Temporal Activity
 * contract. This is the single place a step type becomes executed work.
 */
import { activityInfo } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";

import {
  completeWorkflowStep,
  failWorkflowStep,
  markWorkflowStepRunning,
  withGmailAccountControlLock,
  type WorkflowStepJob,
} from "@invook/database";
import type {
  WorkflowStepExecution,
  WorkflowStepResult,
} from "@invook/workflows";

import { classifyGmailWorkflowFailure } from "./gmail/workflow-failure";
import { GmailConnectionInactiveError } from "./gmail/watch-lifecycle";
import {
  failTerminalThreadLabelAnalysis,
  isThreadLabelWorkflowStep,
  runLabelSubmission,
  threadLabelAnalysisErrorCode,
} from "./label/analysis";
import {
  runThreadLabelBatchEvent,
  runThreadLabelBatchSubmission,
} from "./label/batch";

import {
  runGmailAccountCleanup,
  runGmailHistoryCatchup,
  runGmailMessageRefresh,
  runGmailObjectDelete,
  runGmailWatchRenewal,
} from "./gmail/sync";
import {
  runMemoryBatchEvent,
  runMemoryBatchRetry,
} from "./memory/batch";
import {
  runIncrementalMemoryExtraction,
  runMemoryExtraction,
} from "./memory/extraction";
import { runMemoryFeedback } from "./memory/feedback";

async function persistWorkflowFailure(
  job: WorkflowStepJob,
  message: string,
  terminal: boolean,
  reconnectRequired: boolean,
) {
  const stepUpdated = await failWorkflowStep({
    step: job,
    message,
    terminal,
    reconnectRequired,
  });
  if (!stepUpdated) return;
}

async function runWorkflowStepHandler(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  const run = async (): Promise<Record<string, unknown>> => {
    switch (job.stepType) {
      case "gmail.history.catchup":
        return runGmailHistoryCatchup(job);
      case "gmail.message.refresh":
        return runGmailMessageRefresh(job);
      case "gmail.watch.renew":
        return runGmailWatchRenewal(job);
      case "gmail.objects.delete":
        return runGmailObjectDelete(job);
      case "gmail.account.cleanup":
        return runGmailAccountCleanup(job);
      case "memory.extract":
        return runMemoryExtraction(job);
      case "memory.incremental":
        return runIncrementalMemoryExtraction(job);
      case "memory.batch.retry":
        return runMemoryBatchRetry(job);
      case "memory.batch.event":
        return runMemoryBatchEvent(job);
      case "memory.feedback":
        return runMemoryFeedback(job);
      case "label.recent.scan":
      case "label.thread.assign":
        return runLabelSubmission(job);
      case "label.batch.submit":
        return runThreadLabelBatchSubmission(job);
      case "label.batch.event":
        return runThreadLabelBatchEvent(job);
      default:
        throw new Error(`Unsupported Temporal workflow step: ${job.stepType}`);
    }
  };
  if (
    job.accountId &&
    (job.stepType === "gmail.history.catchup" ||
      job.stepType === "gmail.message.refresh" ||
      job.stepType === "gmail.watch.renew" ||
      job.stepType === "gmail.objects.delete" ||
      job.stepType === "gmail.account.cleanup")
  ) {
    return withGmailAccountControlLock(job.accountId, run);
  }
  return run();
}

function workflowStepJobFromActivity(
  input: WorkflowStepExecution,
): WorkflowStepJob {
  return {
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    runId: input.runId,
    stepType: input.stepType,
    payload: input.payload,
    attempts: input.attempts + activityInfo().attempt,
    maxAttempts: input.maxAttempts,
  };
}

export async function runWorkflowStepActivity(
  input: WorkflowStepExecution,
): Promise<WorkflowStepResult> {
  const job = workflowStepJobFromActivity(input);
  const started = await markWorkflowStepRunning(job.id, job.attempts);
  if (!started.shouldExecute) return { result: started.result };
  try {
    const result = await runWorkflowStepHandler(job);
    await completeWorkflowStep(job.id, result);
    return { result };
  } catch (error) {
    if (error instanceof GmailConnectionInactiveError) {
      const result = { status: "inactive" };
      await completeWorkflowStep(job.id, result);
      return { result };
    }
    const failure = classifyGmailWorkflowFailure(error, {
      attempt: job.attempts,
      maxAttempts: job.maxAttempts,
    });
    const persistedMessage =
      isThreadLabelWorkflowStep(job.stepType)
        ? threadLabelAnalysisErrorCode(error)
        : failure.persistedMessage;
    if (failure.isTerminal) {
      await failTerminalThreadLabelAnalysis(job, error);
    }
    await persistWorkflowFailure(
      job,
      persistedMessage,
      failure.isTerminal,
      failure.isReconnectRequired,
    );
    if (failure.isReconnectRequired) {
      throw ApplicationFailure.nonRetryable(
        "gmail_reconnect_required",
        "GmailReconnectRequired",
      );
    }
    if (failure.isTerminal) {
      throw ApplicationFailure.nonRetryable(
        "workflow_step_terminal_failure",
        "WorkflowStepTerminalFailure",
      );
    }
    throw ApplicationFailure.create({
      message: "workflow_step_retryable_failure",
      type: "WorkflowStepRetryableFailure",
      nonRetryable: false,
    });
  }
}

export async function reconcileWorkflowStepFailureActivity(
  input: WorkflowStepExecution,
): Promise<void> {
  const job: WorkflowStepJob = {
    id: input.id,
    userId: input.userId,
    accountId: input.accountId,
    runId: input.runId,
    stepType: input.stepType,
    payload: input.payload,
    attempts: input.maxAttempts,
    maxAttempts: input.maxAttempts,
  };
  const error = new Error("temporal_activity_terminal_failure");
  await failTerminalThreadLabelAnalysis(job, error);
  await persistWorkflowFailure(
    job,
    isThreadLabelWorkflowStep(job.stepType)
      ? threadLabelAnalysisErrorCode(error)
      : job.stepType.startsWith("gmail.")
        ? "gmail_workflow_activity_failed"
        : "temporal_activity_failed",
    true,
    false,
  );
}
