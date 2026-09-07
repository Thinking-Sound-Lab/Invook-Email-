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
  failHistoricalThreadLabelScan,
  finalizeThreadLabelBatchSubmission,
  getActiveThreadLabelBatchSubmission,
  getThreadLabelBatchSubmission,
  recordThreadLabelBatchInputFile,
  recordThreadLabelProviderBatch,
} from "@invook/database";
import type {
  FailHistoricalLabelScanInput,
  FinalizeHistoricalLabelBatchInput,
  FinalizeHistoricalLabelBatchOutcome,
  SubmitHistoricalLabelBatchInput,
  SubmitHistoricalLabelBatchOutcome,
} from "@invook/workflows";

const terminalBatchStates = new Set([
  "completed",
  "failed",
  "expired",
  "cancelled",
]);

/**
 * Submits the scan's next provider Batch.
 *
 * Every persisted step of the handoff — claim, prepare, upload, create — is
 * checked before it is redone, because the Activity can be retried after any of
 * them and a duplicate upload would bill twice for the same threads.
 */
export async function submitHistoricalLabelBatchActivity(
  input: SubmitHistoricalLabelBatchInput,
): Promise<SubmitHistoricalLabelBatchOutcome> {
  let submission = await getActiveThreadLabelBatchSubmission(
    input.historicalScanId,
  );
  if (submission?.status === "submitted" && submission.providerBatchId) {
    return {
      status: "submitted",
      submissionId: submission.id,
      providerBatchId: submission.providerBatchId,
      requestCount: submission.requestCount,
    };
  }

  const claimed = await claimThreadLabelBatchSubmission({
    userId: input.userId,
    accountId: input.accountId,
    historicalScanId: input.historicalScanId,
    retryAttempt: input.retryAttempt,
    continuations: input.continuations,
    modelId: getThreadLabelBatchModelId(),
    ...(input.threadIds ? { threadIds: input.threadIds } : {}),
  });
  if (claimed.status === "superseded") return { status: "superseded" };
  if (claimed.status === "skipped") {
    return claimed.nextScope
      ? { status: "skipped", nextScope: claimed.nextScope }
      : { status: "exhausted" };
  }

  submission = await getThreadLabelBatchSubmission(claimed.submissionId);
  if (!submission) {
    throw new Error("The claimed thread-label Batch is unavailable.");
  }
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
      // Every candidate fell away during preparation, so the Batch is closed
      // without ever reaching the provider and the scan moves on.
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
      return completion.nextScope
        ? { status: "skipped", nextScope: completion.nextScope }
        : { status: "exhausted" };
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
  };
}

/**
 * Applies a finished provider Batch and reports what the scan owes next.
 *
 * The provider is read rather than trusted from the signal, so a Batch that is
 * still running when the completion wait expires is reported as pending and the
 * Workflow keeps waiting instead of discarding it.
 */
export async function finalizeHistoricalLabelBatchActivity(
  input: FinalizeHistoricalLabelBatchInput,
): Promise<FinalizeHistoricalLabelBatchOutcome> {
  const submission = await getThreadLabelBatchSubmission(input.submissionId);
  if (!submission || !submission.inputFileId) {
    throw new Error("The thread-label Batch could not be matched.");
  }
  if (submission.providerBatchId !== input.providerBatchId) {
    throw new Error("The thread-label Batch provider identity is invalid.");
  }

  const isFinalized =
    submission.status === "complete" || submission.status === "failed";
  if (isFinalized && terminalBatchStates.has(submission.providerState ?? "")) {
    const completion = await finalizeThreadLabelBatchSubmission({
      submissionId: submission.id,
      providerState: submission.providerState ?? "completed",
      providerErrorCode: submission.lastError,
      retryableFailure: false,
      outputFileId: submission.outputFileId,
      errorFileId: submission.errorFileId,
      modelId: submission.modelId,
      results: [],
      failedThreadIds: [],
    });
    await deleteThreadLabelBatchFiles({
      inputFileId: submission.inputFileId,
      outputFileId: submission.outputFileId,
      errorFileId: submission.errorFileId,
    });
    return {
      status: "finalized",
      appliedThreadCount: completion.appliedCount,
      nextScope: completion.nextScope,
    };
  }

  const batch = await readThreadLabelBatch({
    providerBatchId: submission.providerBatchId,
    manifest: isFinalized ? [] : submission.manifest,
  });
  if (!terminalBatchStates.has(batch.state)) return { status: "pending" };

  const failure = classifyThreadLabelBatchFailure({
    providerState: batch.state,
    providerErrors: batch.providerErrors,
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
  await deleteThreadLabelBatchFiles({
    inputFileId: submission.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  return {
    status: "finalized",
    appliedThreadCount: completion.appliedCount,
    nextScope: completion.nextScope,
  };
}

/**
 * Records that a scan cannot proceed.
 *
 * The Workflow calls this after its own retries are exhausted, so the state the
 * user sees matches the state Temporal reached.
 */
export async function failHistoricalLabelScanActivity(
  input: FailHistoricalLabelScanInput,
): Promise<void> {
  await failHistoricalThreadLabelScan(input);
}
