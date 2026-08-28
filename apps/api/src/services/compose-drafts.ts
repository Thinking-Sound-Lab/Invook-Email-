import { createHash } from "node:crypto";

import type {
  GmailComposeDraftFields,
  GmailComposeDraftResponse,
} from "@invook/contracts";
import {
  abandonPendingGmailDraftWrite,
  beginGmailDraftWrite,
  completeGmailDraftWrite,
  enqueueGmailHistoryCatchup,
  getGmailReplyContext,
  type BeginGmailDraftWriteResult,
  type GmailDraftWriteOperation,
  type GmailDraftWriteResult,
} from "@invook/database";
import {
  composePlainTextGmailMessage,
  createGmailDraft,
  getGmailDraft,
  GmailApiError,
  listGmailDrafts,
  updateGmailDraft,
  type GmailDraft,
  type GmailDraftPage,
} from "@invook/gmail";

import type { GmailProviderAccess } from "./gmail-provider";

export class GmailDraftWritePendingError extends Error {
  constructor() {
    super("The previous Gmail draft write is still being resolved.");
    this.name = "GmailDraftWritePendingError";
  }
}

export class GmailReplyContextUnavailableError extends Error {
  constructor() {
    super("Reply message is unavailable for this Gmail account.");
    this.name = "GmailReplyContextUnavailableError";
  }
}

export interface SaveComposeDraftInput {
  userId: string;
  access: GmailProviderAccess;
  operation: GmailDraftWriteOperation;
  idempotencyKey: string;
  fields: GmailComposeDraftFields;
  providerDraftId?: string;
  replyToMessageId?: string;
}

export interface ComposeDraftDependencies {
  beginWrite: typeof beginGmailDraftWrite;
  completeWrite: typeof completeGmailDraftWrite;
  abandonWrite: typeof abandonPendingGmailDraftWrite;
  createDraft: typeof createGmailDraft;
  getDraft: typeof getGmailDraft;
  listDrafts: typeof listGmailDrafts;
  updateDraft: typeof updateGmailDraft;
  enqueueCatchup: typeof enqueueGmailHistoryCatchup;
  getReplyContext: typeof getGmailReplyContext;
}

const defaultDependencies: ComposeDraftDependencies = {
  beginWrite: beginGmailDraftWrite,
  completeWrite: completeGmailDraftWrite,
  abandonWrite: abandonPendingGmailDraftWrite,
  createDraft: createGmailDraft,
  getDraft: getGmailDraft,
  listDrafts: listGmailDrafts,
  updateDraft: updateGmailDraft,
  enqueueCatchup: enqueueGmailHistoryCatchup,
  getReplyContext: getGmailReplyContext,
};

function requestFingerprint(input: SaveComposeDraftInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        providerDraftId: input.providerDraftId ?? null,
        recipients: input.fields.recipients,
        subject: input.fields.subject,
        body: input.fields.body,
        ...(input.fields.ccRecipients
          ? { ccRecipients: input.fields.ccRecipients }
          : {}),
        ...(input.fields.bccRecipients
          ? { bccRecipients: input.fields.bccRecipients }
          : {}),
        ...(input.replyToMessageId
          ? { replyToMessageId: input.replyToMessageId }
          : {}),
      }),
      "utf8",
    )
    .digest("hex");
}

function operationMessageId(operationId: string): string {
  return `invook-compose-${operationId}@invook.invalid`;
}

function providerResult(draft: GmailDraft): GmailDraftWriteResult {
  return {
    providerDraftId: draft.id,
    providerMessageId: draft.message.id,
    providerThreadId: draft.message.threadId,
  };
}

function draftPageResult(page: GmailDraftPage): GmailDraftWriteResult | null {
  const drafts = page.drafts ?? [];
  if (drafts.length !== 1) return null;
  const draft = drafts[0];
  if (!draft) return null;
  return {
    providerDraftId: draft.id,
    providerMessageId: draft.message.id,
    providerThreadId: draft.message.threadId,
  };
}

async function enqueueCatchup(
  input: SaveComposeDraftInput,
  operationId: string,
  dependencies: ComposeDraftDependencies,
): Promise<string> {
  return dependencies.enqueueCatchup({
    userId: input.userId,
    accountId: input.access.accountId,
    reason: "provider_write",
    sourceId: `compose-draft:${operationId}`,
  });
}

async function completedResponse(
  input: SaveComposeDraftInput,
  operationId: string,
  result: GmailDraftWriteResult,
  dependencies: ComposeDraftDependencies,
): Promise<GmailComposeDraftResponse> {
  const stepId = await enqueueCatchup(input, operationId, dependencies);
  return { draft: result, stepId };
}

async function recoverPendingWrite(
  input: SaveComposeDraftInput,
  pending: Extract<BeginGmailDraftWriteResult, { outcome: "pending" }>,
  dependencies: ComposeDraftDependencies,
): Promise<GmailComposeDraftResponse> {
  const page = await dependencies.listDrafts(input.access.accessToken, {
    maxResults: 2,
    query: `rfc822msgid:${operationMessageId(pending.operationId)}`,
  });
  const result = draftPageResult(page);
  if (!result) throw new GmailDraftWritePendingError();
  await dependencies.completeWrite({
    operationId: pending.operationId,
    userId: input.userId,
    result,
  });
  return completedResponse(input, pending.operationId, result, dependencies);
}

export async function saveComposeDraft(
  input: SaveComposeDraftInput,
  dependencies: ComposeDraftDependencies = defaultDependencies,
): Promise<GmailComposeDraftResponse> {
  const replyContext = input.replyToMessageId
    ? await dependencies.getReplyContext({
        userId: input.userId,
        accountId: input.access.accountId,
        messageId: input.replyToMessageId,
      })
    : null;
  if (input.replyToMessageId && !replyContext) {
    throw new GmailReplyContextUnavailableError();
  }
  const write = await dependencies.beginWrite({
    userId: input.userId,
    accountId: input.access.accountId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: requestFingerprint(input),
  });
  if (write.outcome === "complete") {
    return completedResponse(
      input,
      write.operationId,
      write.result,
      dependencies,
    );
  }
  if (write.outcome === "pending") {
    return recoverPendingWrite(input, write, dependencies);
  }

  const raw = composePlainTextGmailMessage({
    accountEmail: input.access.email,
    ...input.fields,
    ...(replyContext
      ? { subject: replyContext.subject, replyTarget: replyContext }
      : {}),
    messageId: operationMessageId(write.operationId),
  });
  if (!raw) {
    await dependencies.abandonWrite({
      operationId: write.operationId,
      userId: input.userId,
    });
    throw new Error("The Gmail message could not be composed.");
  }

  let hasStartedProviderWrite = false;
  try {
    let saved: GmailDraft;
    if (input.operation === "create") {
      hasStartedProviderWrite = true;
      saved = await dependencies.createDraft(input.access.accessToken, {
        raw,
        ...(replyContext ? { threadId: replyContext.providerThreadId } : {}),
      });
    } else {
      if (!input.providerDraftId) {
        throw new Error(
          "A provider draft ID is required to update a Gmail draft.",
        );
      }
      const current = await dependencies.getDraft(
        input.access.accessToken,
        input.providerDraftId,
      );
      if (
        replyContext &&
        current.message.threadId !== replyContext.providerThreadId
      ) {
        throw new GmailReplyContextUnavailableError();
      }
      hasStartedProviderWrite = true;
      saved = await dependencies.updateDraft(
        input.access.accessToken,
        input.providerDraftId,
        { raw, threadId: current.message.threadId },
      );
    }
    const result = providerResult(saved);
    await dependencies.completeWrite({
      operationId: write.operationId,
      userId: input.userId,
      result,
    });
    return completedResponse(input, write.operationId, result, dependencies);
  } catch (error) {
    const isKnownProviderRejection =
      error instanceof GmailApiError && error.status > 0;
    if (!hasStartedProviderWrite || isKnownProviderRejection) {
      await dependencies.abandonWrite({
        operationId: write.operationId,
        userId: input.userId,
      });
    }
    throw error;
  }
}
