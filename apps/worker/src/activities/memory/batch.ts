/**
 * Memory batch submission retries and provider batch completion events.
 */
import {
  deleteMemoryBatchFiles,
  isMemoryBatchProviderConfigured,
  MemoryBatchConfigurationError,
  readMemoryBatch,
  submitMemoryBatch,
  type MessageMemoryCandidate,
} from "@invook/ai";
import {
  enqueuePendingAnalysisWorkflowSteps,
  enqueueMemoryBatchRetry,
  getMemoryAnalysisThreads,
  getUserAuthoredMemories,
  getWorkerAccount,
  getBatchSubmission,
  saveExtractedMemories,
  setMemorySyncStage,
  type WorkflowStepJob,
} from "@invook/database";

import {
  clearMemoryEvidenceUsedByCandidates,
  deduplicateCandidates,
  parseManifest,
  parseSubmissionResult,
  requiredInteger,
  requiredString,
  toMemoryAnalysisThreads,
  validateBatchCandidates,
} from "./candidates";

export async function runMemoryBatchRetry(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Memory retry has no connected account.");
  const parentSubmissionJobId = requiredString(
    job.payload.parentSubmissionJobId,
    "Parent Memory submission job ID",
  );
  const parentSubmission = await getBatchSubmission(parentSubmissionJobId);
  if (parentSubmission?.accountId !== job.accountId) {
    throw new Error("The parent Memory submission could not be matched to this account.");
  }
  const parentDetails = parseSubmissionResult(parentSubmission.result);
  if (!parentDetails) {
    return { status: "superseded", provider: "unsupported" };
  }

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  if (!isMemoryBatchProviderConfigured(parentDetails.provider)) {
    throw new MemoryBatchConfigurationError(
      `The ${parentDetails.provider} provider used by this Memory Batch retry is not configured.`,
    );
  }

  const batchAttempt = requiredInteger(
    job.payload.batchAttempt,
    "Memory Batch attempt",
  );
  const rootSubmissionJobId = requiredString(
    job.payload.rootSubmissionJobId,
    "Root Memory submission job ID",
  );
  if (typeof job.payload.replaceExisting !== "boolean") {
    throw new Error("The Memory retry replacement state is missing.");
  }
  const manifest = parseManifest(job.payload.manifest);
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id),
    account.email,
  );
  const submission = await submitMemoryBatch({
    provider: parentDetails.provider,
    submissionId: job.id,
    batchAttempt,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    retryManifest: manifest,
  });
  if (!submission) {
    throw new Error("The Memory Batch retry produced no requests.");
  }

  return {
    status: "submitted",
    ...submission,
    batchAttempt,
    rootSubmissionJobId,
    replaceExisting: job.payload.replaceExisting,
    pendingScope: parentDetails.pendingScope,
  };
}

export async function runMemoryBatchEvent(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The Memory batch event has no account.");
  const submissionJobId = requiredString(
    job.payload.submissionJobId,
    "Memory submission job ID",
  );
  const submission = await getBatchSubmission(submissionJobId);
  if (!submission?.accountId || !submission.userId || submission.accountId !== job.accountId) {
    throw new Error("The Memory Batch submission could not be matched to this account.");
  }
  const details = parseSubmissionResult(submission.result);
  if (!details) {
    return { status: "superseded", provider: "unsupported" };
  }
  const providerBatchId = requiredString(
    job.payload.providerBatchId,
    "provider event batch ID",
  );
  if (job.payload.provider !== details.provider) {
    throw new Error("The provider event does not match its Memory submission.");
  }
  if (providerBatchId !== details.providerBatchId) {
    throw new Error("The provider event does not match its Memory submission.");
  }

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id),
    account.email,
  );
  const messagesById = new Map(
    threads.flatMap((thread) =>
      thread.messages.map((message) => [message.id, message] as const),
    ),
  );
  const batch = await readMemoryBatch({
    provider: details.provider,
    providerBatchId: details.providerBatchId,
    modelId: details.modelId,
    expectedKeys: details.manifest.map((entry) => entry.key),
  });
  const terminalState =
    batch.state === "completed" ||
    batch.state === "failed" ||
    batch.state === "cancelled" ||
    batch.state === "expired";
  if (!terminalState) {
    throw new Error(
      `${details.provider} emitted a terminal event while the batch is ${batch.state}.`,
    );
  }

  const failedKeys = new Set(batch.failedKeys);
  const candidates: MessageMemoryCandidate[] = [];
  for (const entry of details.manifest) {
    if (failedKeys.has(entry.key)) continue;
    candidates.push(
      ...validateBatchCandidates({
        candidates: batch.candidatesByKey.get(entry.key) ?? [],
        manifest: entry,
        messagesById,
      }),
    );
  }
  const memories = deduplicateCandidates(candidates);
  const failedManifest = details.manifest.filter((entry) => failedKeys.has(entry.key));
  const hasSuccessfulRequests = failedManifest.length < details.manifest.length;

  if (hasSuccessfulRequests) {
    await saveExtractedMemories({
      userId: submission.userId,
      accountId: submission.accountId,
      source: "inferred",
      modelId: batch.modelId,
      memories,
      replaceExisting: details.replaceExisting,
      markComplete:
        details.pendingScope === null && failedManifest.length === 0,
    });
    await clearMemoryEvidenceUsedByCandidates(submission.accountId, memories);

    if (details.pendingScope === null && failedManifest.length === 0) {
      await enqueuePendingAnalysisWorkflowSteps();
    }
  }

  let retryJobId: string | null = null;
  if (failedManifest.length > 0 && details.batchAttempt < submission.maxAttempts) {
    retryJobId = await enqueueMemoryBatchRetry({
      userId: submission.userId,
      accountId: submission.accountId,
      parentSubmissionJobId: submission.id,
      rootSubmissionJobId: details.rootSubmissionJobId,
      batchAttempt: details.batchAttempt + 1,
      replaceExisting: hasSuccessfulRequests ? false : details.replaceExisting,
      manifest: failedManifest,
    });
  } else if (failedManifest.length > 0) {
    await setMemorySyncStage(submission.accountId, "failed");
  } else if (!hasSuccessfulRequests && details.pendingScope === null) {
    await setMemorySyncStage(submission.accountId, "complete");
  }

  const cleanupFailures = await deleteMemoryBatchFiles({
    provider: details.provider,
    inputFileId: details.inputFileId,
    outputFileId: batch.outputFileId,
    errorFileId: batch.errorFileId,
  });
  if (cleanupFailures.length > 0) {
    console.error("worker: Memory Batch files could not be deleted", {
      provider: details.provider,
      submissionJobId: submission.id,
      fileCount: cleanupFailures.length,
    });
  }

  return {
    status:
      failedManifest.length === 0
        ? "complete"
        : retryJobId
          ? "retry_submitted"
          : "failed",
    providerState: batch.state,
    provider: details.provider,
    providerError: batch.providerError,
    candidateCount: candidates.length,
    memoryCount: memories.length,
    failedRequestCount: failedManifest.length,
    retryJobId,
  };
}
