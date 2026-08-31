import { validate as validateUuid } from "uuid";

import {
  classifyThreadLabelBatchFailure,
  createThreadLabelBatch,
  deleteThreadLabelBatchFiles,
  findThreadLabelBatchInputFileBySubmissionId,
  findThreadLabelBatchBySubmissionId,
  getThreadLabelBatchModelId,
  prepareThreadLabelBatch,
  readThreadLabelBatch,
  uploadThreadLabelBatchInput,
} from "@invook/ai";
import {
  claimThreadLabelBatchSubmission,
  finalizeThreadLabelBatchPreparation,
  finalizeThreadLabelBatchSubmission,
  getThreadLabelBatchSubmissionForStep,
  recordThreadLabelBatchInputFile,
  recordThreadLabelProviderBatch,
  type ThreadLabelBatchContinuation,
  type WorkflowStepJob,
} from "@invook/database";

const terminalBatchStates = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is missing.`);
  return value;
}

function optionalThreadIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 2_000) {
    throw new Error("Thread-label Batch retry thread IDs are invalid.");
  }
  const threadIds = Array.from(
    new Set(
      value.map((threadId) => {
        const id = requiredString(threadId, "Thread-label retry ID");
        if (!validateUuid(id))
          throw new Error("A thread-label retry ID must be a UUID.");
        return id;
      }),
    ),
  );
  return threadIds;
}

function parseThreadLabelBatchContinuations(
  value: unknown,
): ThreadLabelBatchContinuation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2_000)
    throw new Error("The Batch continuations are invalid.");
  const threadIdsSeen = new Set<string>();
  const continuations: ThreadLabelBatchContinuation[] = [];
  for (const continuation of value) {
    if (
      !continuation ||
      typeof continuation !== "object" ||
      !("retryAttempt" in continuation) ||
      !("threadIds" in continuation)
    ) {
      throw new Error("The Batch continuation is invalid.");
    }
    const retryAttempt = continuation.retryAttempt;
    const threadIds = optionalThreadIds(continuation.threadIds);
    if (
      typeof retryAttempt !== "number" ||
      !Number.isInteger(retryAttempt) ||
      retryAttempt < 1 ||
      retryAttempt > 6 ||
      !threadIds
    ) {
      throw new Error("The Batch continuation checkpoint is invalid.");
    }
    for (const threadId of threadIds) {
      if (threadIdsSeen.has(threadId) || threadIdsSeen.size >= 2_000)
        throw new Error("The Batch continuation threads are invalid.");
      threadIdsSeen.add(threadId);
    }
    continuations.push({ retryAttempt, threadIds });
  }
  return continuations;
}

export function parseThreadLabelBatchPayload(
  payload: Record<string, unknown>,
): {
  historicalScanId: string;
  retryAttempt: number;
  threadIds: string[] | undefined;
  continuations: ThreadLabelBatchContinuation[];
} {
  const historicalScanId = requiredString(
    payload.historicalScanId,
    "Historical label request ID",
  );
  if (!validateUuid(historicalScanId))
    throw new Error("The historical label request ID must be a UUID.");
  const retryAttempt = payload.retryAttempt;
  if (
    typeof retryAttempt !== "number" ||
    !Number.isInteger(retryAttempt) ||
    retryAttempt < 0 ||
    retryAttempt > 6
  ) {
    throw new Error("The historical label retry attempt is invalid.");
  }
  const threadIds = optionalThreadIds(payload.threadIds);
  const continuations = parseThreadLabelBatchContinuations(
    payload.continuations,
  );
  const continuedThreadIds = continuations.flatMap(
    (continuation) => continuation.threadIds,
  );
  const allThreadIds = [...(threadIds ?? []), ...continuedThreadIds];
  if (
    (retryAttempt === 0 && (threadIds || continuations.length > 0)) ||
    (retryAttempt > 0 && !threadIds) ||
    allThreadIds.length > 2_000 ||
    new Set(allThreadIds).size !== allThreadIds.length
  ) {
    throw new Error("The historical label retry scope is invalid.");
  }
  return { historicalScanId, retryAttempt, threadIds, continuations };
}

export async function runThreadLabelBatchSubmission(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType !== "label.batch.submit" || !job.userId || !job.accountId) {
    throw new Error("The thread-label Batch submission identity is invalid.");
  }
  const { historicalScanId, retryAttempt, threadIds, continuations } =
    parseThreadLabelBatchPayload(job.payload);
  let submission = await getThreadLabelBatchSubmissionForStep(job.id);
  if (submission?.status === "complete" || submission?.status === "submitted") {
    return {
      status: submission.status,
      submissionId: submission.id,
      providerBatchId: submission.providerBatchId,
    };
  }
  const claimed = await claimThreadLabelBatchSubmission({
    workflowStepId: job.id,
    userId: job.userId,
    accountId: job.accountId,
    historicalScanId,
    retryAttempt,
    continuations,
    modelId: getThreadLabelBatchModelId(),
    threadIds,
  });
  if (!claimed) return { status: "insufficient_candidates" };

  submission = await getThreadLabelBatchSubmissionForStep(job.id);
  if (!submission)
    throw new Error("The claimed thread-label Batch is unavailable.");
  let jsonl: string | null = null;
  // Recover an uncertain upload before preparing again: its manifest was
  // persisted before upload, and must still describe the uploaded file.
  if (!submission.inputFileId && !submission.providerBatchId) {
    const uploadedInputFileId =
      await findThreadLabelBatchInputFileBySubmissionId(submission.id);
    if (uploadedInputFileId) {
      await recordThreadLabelBatchInputFile({
        submissionId: submission.id,
        inputFileId: uploadedInputFileId,
      });
      submission = { ...submission, inputFileId: uploadedInputFileId };
    }
  }
  if (!submission.inputFileId && !submission.providerBatchId) {
    const prepared = prepareThreadLabelBatch({ entries: claimed.candidates });
    if (prepared.manifest.length === 0) {
      const completion = await finalizeThreadLabelBatchSubmission({
        submissionId: submission.id,
        providerState: "completed",
        providerErrorCode: null,
        retryableFailure: false,
        outputFileId: null,
        errorFileId: null,
        modelId: submission.modelId,
        results: [],
        failedThreadIds: [],
      });
      return { status: "superseded", ...completion };
    }
    const preparedThreadIds = new Set(
      prepared.manifest.map((entry) => entry.threadId),
    );
    submission = await finalizeThreadLabelBatchPreparation({
      submissionId: claimed.submissionId,
      manifest: prepared.manifest,
      excludedThreadIds: submission.manifest
        .map((entry) => entry.threadId)
        .filter((threadId) => !preparedThreadIds.has(threadId)),
    });
    jsonl = prepared.jsonl;
  }

  let inputFileId = submission.inputFileId;
  if (!inputFileId) {
    if (!jsonl)
      throw new Error("The prepared thread-label Batch input is unavailable.");
    const uploadedInputFileId = await uploadThreadLabelBatchInput({
      submissionId: submission.id,
      jsonl,
    });
    inputFileId = await recordThreadLabelBatchInputFile({
      submissionId: submission.id,
      inputFileId: uploadedInputFileId,
    });
  }

  let providerBatchId = submission.providerBatchId;
  if (!providerBatchId) {
    const existing = await findThreadLabelBatchBySubmissionId(submission.id);
    const providerBatch =
      existing ??
      (await createThreadLabelBatch({
        submissionId: submission.id,
        inputFileId,
      }));
    submission = await recordThreadLabelProviderBatch({
      submissionId: submission.id,
      providerBatchId: providerBatch.providerBatchId,
      inputFileId: providerBatch.inputFileId,
    });
    providerBatchId = submission.providerBatchId;
  }
  if (!providerBatchId)
    throw new Error("The OpenAI thread-label Batch has no identity.");

  return {
    status: "submitted",
    submissionId: submission.id,
    providerBatchId,
    requestCount: submission.requestCount,
    continuationStepId: null,
  };
}

export async function runThreadLabelBatchEvent(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType !== "label.batch.event") {
    throw new Error("The thread-label Batch event type is invalid.");
  }
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "Thread-label submission job ID",
  );
  const submission =
    await getThreadLabelBatchSubmissionForStep(submissionJobId);
  if (!submission || !submission.providerBatchId || !submission.inputFileId) {
    throw new Error("The thread-label Batch event could not be matched.");
  }
  if (
    requiredString(
      job.payload.providerBatchId,
      "Thread-label provider Batch ID",
    ) !== submission.providerBatchId
  ) {
    throw new Error(
      "The thread-label Batch event provider identity is invalid.",
    );
  }
  const isFinalized =
    submission.status === "complete" || submission.status === "failed";
  if (isFinalized && terminalBatchStates.has(submission.providerState ?? "")) {
    const undeletedFileIds = await deleteThreadLabelBatchFiles({
      inputFileId: submission.inputFileId,
      outputFileId: submission.outputFileId,
      errorFileId: submission.errorFileId,
    });
    return {
      status: "complete",
      submissionId: submission.id,
      appliedCount: 0,
      alreadyFinalized: true,
      continuationStepId: null,
      undeletedFileIds,
    };
  }
  const batch = await readThreadLabelBatch({
    providerBatchId: submission.providerBatchId,
    manifest: isFinalized ? [] : submission.manifest,
  });
  if (!terminalBatchStates.has(batch.state)) {
    throw new Error(
      `OpenAI emitted a terminal event while the thread-label Batch is ${batch.state}.`,
    );
  }
  const failure = classifyThreadLabelBatchFailure({
    providerState: batch.state,
    providerError: batch.providerError,
  });
  const completion = await finalizeThreadLabelBatchSubmission({
    submissionId: submission.id,
    providerState: batch.state,
    providerErrorCode: failure.errorCode,
    retryableFailure: failure.isRetryable,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
    modelId: batch.modelId,
    results: batch.results,
    failedThreadIds: batch.failedThreadIds,
  });
  const undeletedFileIds = await deleteThreadLabelBatchFiles({
    inputFileId: submission.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  return {
    status: "complete",
    submissionId: submission.id,
    appliedCount: completion.appliedCount,
    alreadyFinalized: completion.alreadyFinalized,
    continuationStepId: completion.continuationStepId,
    undeletedFileIds,
  };
}
