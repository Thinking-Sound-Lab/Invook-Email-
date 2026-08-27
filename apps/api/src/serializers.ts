import { isAiConfigured } from "@invook/ai";
import type {
  MailboxShell,
  MemoryEntry,
  AiReplyDraft,
  SignedInUser,
} from "@invook/contracts";
import type { getMailboxShellData } from "@invook/database";

export function serializeMailboxShell(
  shell: NonNullable<Awaited<ReturnType<typeof getMailboxShellData>>>,
  user: SignedInUser,
): MailboxShell {
  return {
    aiConfigured: isAiConfigured(),
    user,
    accounts: shell.accounts,
    accountLabels: shell.accountLabels,
  };
}

export function serializeMemoryEntry(memory: {
  id: string;
  memoryType: MemoryEntry["type"];
  contactEmail: string | null;
  statement: string;
  source: MemoryEntry["source"];
  confidence: string | null;
  evidenceMessageIds: string[];
  evidenceDraftIds: string[];
  createdAt: Date;
  updatedAt: Date;
}): MemoryEntry {
  return {
    id: memory.id,
    type: memory.memoryType,
    contactEmail: memory.contactEmail,
    statement: memory.statement,
    source: memory.source,
    confidence: memory.confidence === null ? null : Number(memory.confidence),
    evidenceMessageIds: memory.evidenceMessageIds,
    evidenceDraftIds: memory.evidenceDraftIds,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

export function serializeReplyDraft(draft: {
  id: string;
  threadId: string | null;
  status: AiReplyDraft["status"];
  generatedText: string | null;
  currentText: string;
  usedMemoryIds: string[];
  updatedAt: Date;
}): AiReplyDraft {
  if (!draft.threadId || !draft.generatedText) {
    throw new Error("A generated draft is missing its local thread contract.");
  }
  return {
    id: draft.id,
    threadId: draft.threadId,
    status: draft.status,
    generatedText: draft.generatedText,
    currentText: draft.currentText,
    usedMemoryIds: draft.usedMemoryIds,
    updatedAt: draft.updatedAt.toISOString(),
  };
}
