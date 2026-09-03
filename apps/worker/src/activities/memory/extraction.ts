/**
 * Memory extraction over stored threads, in full and incremental form.
 */
import {
  isMemoryBatchConfigured,
  MemoryBatchConfigurationError,
  submitMemoryBatch,
} from "@invook/ai";
import {
  enqueuePendingAnalysisWorkflowSteps,
  getMemoryAnalysisThreads,
  getUserAuthoredMemories,
  getWorkerAccount,
  MEMORY_SCHEMA_VERSION,
  saveExtractedMemories,
  setMemorySyncStage,
  type WorkflowStepJob,
} from "@invook/database";

import { toMemoryAnalysisThreads } from "./candidates";

export async function runMemoryExtraction(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The memory job has no connected account.");
  if (job.payload.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return {
      status: "superseded",
      requestedSchemaVersion: job.payload.schemaVersion ?? null,
      currentSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }
  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");

  const indexedThreads = await getMemoryAnalysisThreads(account.id);
  const threads = toMemoryAnalysisThreads(indexedThreads, account.email);
  const evidenceMessageCount = threads.reduce(
    (total, thread) =>
      total + thread.messages.filter((message) => message.ownerEvidence).length,
    0,
  );
  if (evidenceMessageCount < 3) {
    await saveExtractedMemories({
      userId: account.userId,
      accountId: account.id,
      source: "inferred",
      modelId: null,
      memories: [],
    });
    await enqueuePendingAnalysisWorkflowSteps();
    return {
      status: "complete",
      threadCount: threads.length,
      evidenceMessageCount,
      memoryCount: 0,
    };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  await setMemorySyncStage(account.id, "running");
  const submission = await submitMemoryBatch({
    submissionId: job.id,
    batchAttempt: 1,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
  });
  if (!submission) {
    await saveExtractedMemories({
      userId: account.userId,
      accountId: account.id,
      source: "inferred",
      modelId: null,
      memories: [],
    });
    await enqueuePendingAnalysisWorkflowSteps();
    return {
      status: "complete",
      threadCount: threads.length,
      evidenceMessageCount,
      memoryCount: 0,
    };
  }

  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    replaceExisting: true,
    pendingScope: null,
    threadCount: threads.length,
    evidenceMessageCount,
  };
}

export async function runIncrementalMemoryExtraction(job: WorkflowStepJob) {
  if (!job.accountId) throw new Error("The incremental Memory job has no account.");
  if (job.payload.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    return {
      status: "superseded",
      requestedSchemaVersion: job.payload.schemaVersion ?? null,
      currentSchemaVersion: MEMORY_SCHEMA_VERSION,
    };
  }
  const mode = job.payload.mode;
  const contactEmail = job.payload.contactEmail;
  const evidenceMessageIds = job.payload.evidenceMessageIds;
  if (
    (mode !== "global" && mode !== "contact") ||
    (mode === "global" && contactEmail !== null) ||
    (mode === "contact" &&
      (typeof contactEmail !== "string" || !contactEmail.trim())) ||
    !Array.isArray(evidenceMessageIds) ||
    evidenceMessageIds.some((id) => typeof id !== "string")
  ) {
    throw new Error("The incremental Memory evidence scope is invalid.");
  }
  const normalizedContactEmail =
    mode === "contact" ? String(contactEmail).trim().toLowerCase() : null;

  const account = await getWorkerAccount(job.accountId);
  if (!account) throw new Error("The connected Gmail account was not found.");
  const threads = toMemoryAnalysisThreads(
    await getMemoryAnalysisThreads(account.id, evidenceMessageIds),
    account.email,
  );
  const availableEvidenceIds = new Set(
    threads.flatMap((thread) =>
      thread.messages
        .filter((message) => message.ownerEvidence)
        .map((message) => message.id),
    ),
  );
  const currentEvidenceMessageIds = evidenceMessageIds.filter((id) =>
    availableEvidenceIds.has(id),
  );
  if (currentEvidenceMessageIds.length < 3) {
    return {
      status: "waiting_for_repetition",
      evidenceMessageCount: currentEvidenceMessageIds.length,
    };
  }
  if (!isMemoryBatchConfigured()) throw new MemoryBatchConfigurationError();

  const submission = await submitMemoryBatch({
    submissionId: job.id,
    batchAttempt: 1,
    threads,
    protectedMemories: await getUserAuthoredMemories(account.id),
    scopeSelection: {
      mode,
      contactEmail: normalizedContactEmail,
    },
  });
  if (!submission) {
    throw new Error("The incremental Memory Batch produced no requests.");
  }
  return {
    status: "submitted",
    ...submission,
    batchAttempt: 1,
    rootSubmissionJobId: job.id,
    replaceExisting: false,
    pendingScope: {
      mode,
      contactEmail: normalizedContactEmail,
    },
  };
}
