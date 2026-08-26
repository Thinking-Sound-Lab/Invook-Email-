import { validate as validateUuid } from "uuid";

import {
  AiConfigurationError,
  classifyStoredThreadLabel,
  createStoredThreadLabelInputHash,
  isAiConfigured,
  ThreadLabelClassificationContractError,
  type InvookLabelDefinitionForAnalysis,
  type StoredThreadLabelClassification,
  type StoredThreadLabelClassifierInput,
} from "@invook/ai";
import {
  beginHistoricalThreadLabelScan,
  beginThreadLabelAnalysis,
  completeHistoricalThreadLabelScan,
  completeThreadLabelAnalysis,
  failThreadLabelAnalysis,
  scanHistoricalThreadLabelPage,
  type HistoricalThreadLabelCheckpoint,
  type HistoricalThreadLabelScanCoordinatorCheckpoint,
  type ThreadLabelAnalysisCheckpoint,
  type WorkflowStepJob,
} from "@invook/database";

export type ThreadLabelAnalysisJob = {
  userId: string;
  accountId: string;
  checkpoint: ThreadLabelAnalysisCheckpoint;
};

export type HistoricalThreadLabelScanJob = {
  userId: string;
  accountId: string;
  checkpoint: HistoricalThreadLabelCheckpoint;
};

export type HistoricalThreadLabelScanCoordinatorJob = {
  userId: string;
  accountId: string;
  checkpoint: HistoricalThreadLabelScanCoordinatorCheckpoint;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is missing.`);
  }
  return value;
}

function requiredUuid(value: unknown, name: string): string {
  const identifier = requiredString(value, name);
  if (!validateUuid(identifier)) throw new Error(`${name} must be a UUID.`);
  return identifier;
}

function requiredSha256(value: unknown, name: string): string {
  const hash = requiredString(value, name);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, name: string): number | null {
  return value === null ? null : requiredPositiveInteger(value, name);
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : requiredString(value, name);
}

function nullableUuid(value: unknown, name: string): string | null {
  return value === null ? null : requiredUuid(value, name);
}

function requiredDate(value: unknown, name: string): Date {
  const serialized = requiredString(value, name);
  const parsed = new Date(serialized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be an ISO timestamp.`);
  }
  return parsed;
}

export function parseHistoricalThreadLabelScanCoordinatorJob(
  job: WorkflowStepJob,
): HistoricalThreadLabelScanCoordinatorJob {
  if (job.stepType !== "label.historical.scan") {
    throw new Error(`Unsupported historical label coordinator step: ${job.stepType}`);
  }
  return {
    userId: requiredString(job.userId, "Historical label coordinator user ID"),
    accountId: requiredString(
      job.accountId,
      "Historical label coordinator account ID",
    ),
    checkpoint: {
      historicalScanId: requiredUuid(
        job.payload.historicalScanId,
        "Historical label coordinator scan ID",
      ),
      previewReceiptId: nullableUuid(
        job.payload.previewReceiptId,
        "Historical label coordinator preview receipt ID",
      ),
      labelId: requiredString(
        job.payload.labelId,
        "Historical label coordinator label ID",
      ),
      definitionVersion: requiredPositiveInteger(
        job.payload.definitionVersion,
        "Historical label coordinator definition version",
      ),
      enablementVersion: requiredPositiveInteger(
        job.payload.enablementVersion,
        "Historical label coordinator enablement version",
      ),
      after: requiredDate(
        job.payload.after,
        "Historical label coordinator cutoff",
      ),
      cursorThreadId: nullableString(
        job.payload.cursorThreadId,
        "Historical label coordinator cursor",
      ),
    },
  };
}

export function parseHistoricalThreadLabelScanJob(
  job: WorkflowStepJob,
): HistoricalThreadLabelScanJob {
  if (job.stepType !== "label.thread.scan") {
    throw new Error(`Unsupported historical thread label step: ${job.stepType}`);
  }
  return {
    userId: requiredString(job.userId, "Historical label user ID"),
    accountId: requiredString(job.accountId, "Historical label account ID"),
    checkpoint: {
      historicalScanId: requiredUuid(
        job.payload.historicalScanId,
        "Historical label scan ID",
      ),
      previewReceiptId: nullableUuid(
        job.payload.previewReceiptId,
        "Historical label preview receipt ID",
      ),
      threadId: requiredString(job.payload.threadId, "Historical label thread ID"),
      labelId: requiredString(job.payload.labelId, "Historical label ID"),
      definitionVersion: requiredPositiveInteger(
        job.payload.definitionVersion,
        "Historical label definition version",
      ),
      enablementVersion: requiredPositiveInteger(
        job.payload.enablementVersion,
        "Historical label enablement version",
      ),
      assignmentVersion: nullablePositiveInteger(
        job.payload.assignmentVersion,
        "Historical label assignment version",
      ),
    },
  };
}

export function parseThreadLabelAnalysisJob(
  job: WorkflowStepJob,
): ThreadLabelAnalysisJob {
  if (job.stepType !== "label.thread.assign") {
    throw new Error(`Unsupported thread label step: ${job.stepType}`);
  }
  return {
    userId: requiredString(job.userId, "Thread label user ID"),
    accountId: requiredString(job.accountId, "Thread label account ID"),
    checkpoint: {
      threadId: requiredString(job.payload.threadId, "Thread label thread ID"),
      analysisVersion: requiredPositiveInteger(
        job.payload.analysisVersion,
        "Thread label analysis version",
      ),
      definitionHash: requiredSha256(
        job.payload.definitionHash,
        "Thread label definition hash",
      ),
    },
  };
}

function classifierThread(thread: {
  subject: string;
  messages: Array<{
    subject: string;
    sender: { raw: string };
    recipients: string[];
    bodyText: string;
    sentAt: Date;
  }>;
}): StoredThreadLabelClassifierInput["thread"] {
  return {
    subject: thread.subject,
    messages: thread.messages.map((message) => ({
      subject: message.subject,
      sender: message.sender.raw,
      recipients: message.recipients,
      bodyText: message.bodyText,
      sentAt: message.sentAt.toISOString(),
    })),
  };
}

type HistoricalThreadLabelClassification = {
  modelId: string;
  matched: boolean;
  confidence: number;
  source: "preview" | "model";
};

export async function classifyHistoricalThreadLabel(
  input: {
    thread: StoredThreadLabelClassifierInput["thread"];
    definition: InvookLabelDefinitionForAnalysis;
    previewResult: {
      classifierInputHash: string;
      matched: boolean;
      confidence: number;
      modelId: string;
    } | null;
  },
  classify: (
    input: StoredThreadLabelClassifierInput,
  ) => Promise<StoredThreadLabelClassification> = classifyStoredThreadLabel,
): Promise<HistoricalThreadLabelClassification> {
  if (
    input.previewResult &&
    input.previewResult.classifierInputHash ===
      createStoredThreadLabelInputHash(input.thread)
  ) {
    return {
      modelId: input.previewResult.modelId,
      matched: input.previewResult.matched,
      confidence: input.previewResult.confidence,
      source: "preview",
    };
  }
  const noMatchLabelId = `no-match:${input.definition.id}`;
  const classification = await classify({
    thread: input.thread,
    labelDefinitions: [input.definition],
    fallbackLabelId: noMatchLabelId,
  });
  return {
    modelId: classification.modelId,
    matched: classification.labelId === input.definition.id,
    confidence: classification.confidence,
    source: "model",
  };
}

export async function runThreadLabelAnalysis(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  const parsed = parseThreadLabelAnalysisJob(job);
  if (!isAiConfigured()) {
    const deferred = await failThreadLabelAnalysis({
      ...parsed,
      errorCode: "label_analysis_model_unavailable",
    });
    return {
      status: deferred ? "batch_fallback" : "superseded",
      threadId: parsed.checkpoint.threadId,
    };
  }
  const analysis = await beginThreadLabelAnalysis(parsed);
  if (analysis.status !== "ready") {
    return { status: analysis.status, threadId: parsed.checkpoint.threadId };
  }
  const classification = await classifyStoredThreadLabel({
    thread: classifierThread(analysis.thread),
    labelDefinitions: analysis.definitions,
    fallbackLabelId: analysis.fallback.id,
  });
  const completion = await completeThreadLabelAnalysis({
    ...parsed,
    modelId: classification.modelId,
    labelId: classification.labelId,
    confidence: classification.confidence,
  });
  return { ...completion, threadId: parsed.checkpoint.threadId };
}

export async function runHistoricalThreadLabelScan(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  const parsed = parseHistoricalThreadLabelScanJob(job);
  const analysis = await beginHistoricalThreadLabelScan(parsed);
  if (analysis.status !== "ready") {
    return {
      status: analysis.status,
      threadId: parsed.checkpoint.threadId,
      labelId: parsed.checkpoint.labelId,
    };
  }
  const classification = await classifyHistoricalThreadLabel({
    thread: classifierThread(analysis.thread),
    definition: analysis.definition,
    previewResult: analysis.previewResult,
  });
  const completion = await completeHistoricalThreadLabelScan({
    ...parsed,
    modelId: classification.modelId,
    matched: classification.matched,
    confidence: classification.confidence,
  });
  return {
    ...completion,
    threadId: parsed.checkpoint.threadId,
    labelId: parsed.checkpoint.labelId,
    classificationSource: classification.source,
  };
}

export async function runHistoricalThreadLabelScanCoordinator(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  return scanHistoricalThreadLabelPage(
    parseHistoricalThreadLabelScanCoordinatorJob(job),
  );
}

export function isThreadLabelWorkflowStep(stepType: string): boolean {
  return (
    stepType === "label.thread.assign" ||
    stepType === "label.thread.scan" ||
    stepType === "label.historical.scan"
  );
}

export async function runLabelSubmission(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType === "label.historical.scan") {
    return runHistoricalThreadLabelScanCoordinator(job);
  }
  if (job.stepType === "label.thread.assign") return runThreadLabelAnalysis(job);
  if (job.stepType === "label.thread.scan") {
    return runHistoricalThreadLabelScan(job);
  }
  throw new Error(`Unsupported thread label step: ${job.stepType}`);
}

export function threadLabelAnalysisErrorCode(error: unknown): string {
  if (error instanceof AiConfigurationError) {
    return "label_analysis_model_unavailable";
  }
  if (error instanceof ThreadLabelClassificationContractError) {
    return "label_analysis_invalid_model_output";
  }
  return "label_analysis_failed";
}

export async function failTerminalThreadLabelAnalysis(
  job: WorkflowStepJob,
  error: unknown,
): Promise<boolean> {
  if (job.stepType !== "label.thread.assign") return false;
  let parsed: ThreadLabelAnalysisJob;
  try {
    parsed = parseThreadLabelAnalysisJob(job);
  } catch {
    return false;
  }
  return failThreadLabelAnalysis({
    ...parsed,
    errorCode: threadLabelAnalysisErrorCode(error),
  });
}
