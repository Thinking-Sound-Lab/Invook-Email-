/**
 * Parsing and validation for Memory batch manifests and extracted candidates.
 * Provider output is untrusted, so every field is narrowed before use.
 */
import {
  batchProviders,
  type MemoryAnalysisThread,
  type MemoryBatchManifestEntry,
  type BatchProvider,
  type MessageMemoryCandidate,
} from "@invook/ai";
import {
  clearPendingMemoryEvidence,
  getMemoryAnalysisThreads,
} from "@invook/database";
import { extractEmailAddress } from "@invook/gmail";

import { normalizedEmails } from "../gmail/messages";

type StoredMemoryThread = Awaited<ReturnType<typeof getMemoryAnalysisThreads>>[number];

type MemorySubmissionResult = {
  provider: BatchProvider;
  providerBatchId: string;
  inputFileId: string;
  modelId: string;
  requestCount: number;
  manifest: MemoryBatchManifestEntry[];
  batchAttempt: number;
  rootSubmissionJobId: string;
  replaceExisting: boolean;
  pendingScope: {
    mode: "global" | "contact";
    contactEmail: string | null;
  } | null;
};

export function toMemoryAnalysisThreads(
  threads: StoredMemoryThread[],
  ownerEmail: string,
): MemoryAnalysisThread[] {
  return threads.map((thread) => ({
    id: thread.id,
    subject: thread.subject,
    messages: thread.messages.map((message) => ({
      id: message.id,
      direction: message.direction,
      sender: extractEmailAddress(message.sender.raw || message.sender.email),
      recipients: normalizedEmails(message.recipients, ownerEmail),
      bodyText: message.bodyText,
      sentAt: message.sentAt.toISOString(),
      ownerEvidence: message.ownerEvidence,
    })),
  }));
}

export function parseManifest(value: unknown): MemoryBatchManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("The Memory batch manifest is missing.");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("The Memory batch manifest is invalid.");
    }
    const key = "key" in entry ? entry.key : undefined;
    const mode = "mode" in entry ? entry.mode : undefined;
    const contactEmail = "contactEmail" in entry ? entry.contactEmail : undefined;
    const messageIds = "messageIds" in entry ? entry.messageIds : undefined;
    if (
      typeof key !== "string" ||
      (mode !== "global" && mode !== "contact") ||
      (contactEmail !== null && typeof contactEmail !== "string") ||
      !Array.isArray(messageIds) ||
      messageIds.some((id) => typeof id !== "string")
    ) {
      throw new Error("The Memory batch manifest is invalid.");
    }
    if (mode === "contact" && !contactEmail) {
      throw new Error("A contact Memory batch scope has no contact address.");
    }
    if (mode === "global" && contactEmail !== null) {
      throw new Error("A global Memory batch scope cannot have a contact address.");
    }
    return { key, mode, contactEmail, messageIds };
  });
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing from the batch job.`);
  }
  return value;
}

export function requiredInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} is invalid in the batch job.`);
  }
  return value;
}

export function parseSubmissionResult(value: unknown): MemorySubmissionResult | null {
  if (!value || typeof value !== "object") {
    throw new Error("The Memory Batch submission result is missing.");
  }
  const result = value as Record<string, unknown>;
  if (!batchProviders.includes(result.provider as BatchProvider)) {
    return null;
  }
  const provider = result.provider as BatchProvider;
  if (typeof result.replaceExisting !== "boolean") {
    throw new Error("The Memory Batch replacement state is missing.");
  }
  let pendingScope: MemorySubmissionResult["pendingScope"] = null;
  if (result.pendingScope !== null && result.pendingScope !== undefined) {
    if (!result.pendingScope || typeof result.pendingScope !== "object") {
      throw new Error("The incremental Memory scope is invalid.");
    }
    const mode = "mode" in result.pendingScope ? result.pendingScope.mode : undefined;
    const contactEmail =
      "contactEmail" in result.pendingScope
        ? result.pendingScope.contactEmail
        : undefined;
    if (
      (mode !== "global" && mode !== "contact") ||
      (mode === "global" && contactEmail !== null) ||
      (mode === "contact" &&
        (typeof contactEmail !== "string" || !contactEmail.trim()))
    ) {
      throw new Error("The incremental Memory scope is invalid.");
    }
    pendingScope = {
      mode,
      contactEmail: mode === "contact" ? String(contactEmail) : null,
    };
  }
  const manifest = parseManifest(result.manifest);
  const requestCount = requiredInteger(
    result.requestCount,
    "Memory Batch request count",
  );
  if (
    manifest.length !== requestCount ||
    new Set(manifest.map((entry) => entry.key)).size !== manifest.length
  ) {
    throw new Error(
      "The Memory Batch manifest does not match its request count.",
    );
  }
  return {
    provider,
    providerBatchId: requiredString(
      result.providerBatchId,
      "provider batch ID",
    ),
    inputFileId: requiredString(result.inputFileId, "provider input file"),
    modelId: requiredString(result.modelId, "Memory Batch model"),
    requestCount,
    manifest,
    batchAttempt: requiredInteger(
      result.batchAttempt,
      "Memory Batch attempt",
    ),
    rootSubmissionJobId: requiredString(
      result.rootSubmissionJobId,
      "Root Memory submission job ID",
    ),
    replaceExisting: result.replaceExisting,
    pendingScope,
  };
}

export function deduplicateCandidates(candidates: MessageMemoryCandidate[]) {
  const unique = new Map<string, MessageMemoryCandidate>();
  for (const candidate of candidates) {
    const statement = candidate.statement.trim().replace(/\s+/g, " ");
    const key = [
      candidate.type,
      candidate.contactEmail ?? "",
      statement.toLowerCase(),
    ].join(":");
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...candidate, statement });
      continue;
    }
    unique.set(key, {
      ...existing,
      confidence: Math.max(existing.confidence, candidate.confidence),
      evidenceMessageIds: Array.from(
        new Set([...existing.evidenceMessageIds, ...candidate.evidenceMessageIds]),
      ),
    });
  }
  return Array.from(unique.values());
}

export function validateBatchCandidates(input: {
  candidates: MessageMemoryCandidate[];
  manifest: MemoryBatchManifestEntry;
  messagesById: Map<string, MemoryAnalysisThread["messages"][number]>;
}): MessageMemoryCandidate[] {
  const allowedMessageIds = new Set(input.manifest.messageIds);
  const targetContact = input.manifest.contactEmail?.toLowerCase() ?? null;
  const valid: MessageMemoryCandidate[] = [];

  for (const candidate of input.candidates) {
    const evidenceMessageIds = Array.from(new Set(candidate.evidenceMessageIds));
    const evidence = evidenceMessageIds.map((id) => input.messagesById.get(id));
    if (
      evidenceMessageIds.length < 3 ||
      evidenceMessageIds.some((id) => !allowedMessageIds.has(id)) ||
      evidence.some((message) => !message?.ownerEvidence)
    ) {
      continue;
    }

    if (input.manifest.mode === "contact") {
      if (candidate.type !== "contact" || !targetContact) continue;
      if (
        evidence.some(
          (message) =>
            !message?.recipients.some(
              (recipient) => recipient.toLowerCase() === targetContact,
            ),
        )
      ) {
        continue;
      }
      valid.push({ ...candidate, contactEmail: targetContact, evidenceMessageIds });
      continue;
    }

    if (candidate.type === "contact") continue;
    if (candidate.type === "preference") {
      const contacts = new Set(
        evidence.flatMap((message) => message?.recipients ?? []),
      );
      if (contacts.size < 3) continue;
    }
    valid.push({ ...candidate, contactEmail: null, evidenceMessageIds });
  }

  return valid;
}

export async function clearMemoryEvidenceUsedByCandidates(
  accountId: string,
  memories: MessageMemoryCandidate[],
) {
  const evidenceByScope = new Map<
    string,
    {
      mode: "global" | "contact";
      contactEmail: string | null;
      messageIds: Set<string>;
    }
  >();
  for (const memory of memories) {
    const mode = memory.type === "contact" ? "contact" : "global";
    const contactEmail = mode === "contact" ? memory.contactEmail : null;
    if (mode === "contact" && !contactEmail) continue;
    const key = `${mode}:${contactEmail ?? ""}`;
    const scope = evidenceByScope.get(key) ?? {
      mode,
      contactEmail,
      messageIds: new Set<string>(),
    };
    for (const messageId of memory.evidenceMessageIds) {
      scope.messageIds.add(messageId);
    }
    evidenceByScope.set(key, scope);
  }

  await Promise.all(
    Array.from(evidenceByScope.values()).map((scope) =>
      clearPendingMemoryEvidence({
        accountId,
        mode: scope.mode,
        contactEmail: scope.contactEmail,
        messageIds: Array.from(scope.messageIds),
      }),
    ),
  );
}
