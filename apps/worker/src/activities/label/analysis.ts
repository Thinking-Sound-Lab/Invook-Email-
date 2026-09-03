import { validate as validateUuid } from "uuid";

import {
  AiConfigurationError,
  classifyStoredThreadLabel,
  isAiConfigured,
  ThreadLabelClassificationContractError,
  type StoredThreadLabelClassifierInput,
} from "@invook/ai";
import {
  beginThreadLabelAnalysis,
  completeThreadLabelAnalysis,
  failThreadLabelAnalysis,
  scanRecentThreadLabelPage,
  type ThreadLabelAnalysisCheckpoint,
  type WorkflowStepJob,
} from "@invook/database";

export type ThreadLabelAnalysisJob = {
  userId: string;
  accountId: string;
  checkpoint: ThreadLabelAnalysisCheckpoint;
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

function requiredDate(value: unknown, name: string): Date {
  const serialized = requiredString(value, name);
  const parsed = new Date(serialized);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be an ISO timestamp.`);
  }
  return parsed;
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
      status: deferred ? "failed" : "superseded",
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

export function parseRecentThreadLabelScanJob(job: WorkflowStepJob): {
  userId: string;
  accountId: string;
  referenceAt: Date;
  cursorThreadId: string | null;
} {
  if (job.stepType !== "label.recent.scan")
    throw new Error("The recent label scan type is invalid.");
  return {
    userId: requiredString(job.userId, "Recent label user ID"),
    accountId: requiredString(job.accountId, "Recent label account ID"),
    referenceAt: requiredDate(
      job.payload.referenceAt,
      "Recent label reference time",
    ),
    cursorThreadId:
      job.payload.cursorThreadId === null
        ? null
        : requiredUuid(job.payload.cursorThreadId, "Recent label cursor"),
  };
}

export function isThreadLabelWorkflowStep(stepType: string): boolean {
  return stepType.startsWith("label.");
}

export async function runLabelSubmission(
  job: WorkflowStepJob,
): Promise<Record<string, unknown>> {
  if (job.stepType === "label.recent.scan")
    return scanRecentThreadLabelPage(parseRecentThreadLabelScanJob(job));
  if (job.stepType === "label.thread.assign")
    return runThreadLabelAnalysis(job);
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
