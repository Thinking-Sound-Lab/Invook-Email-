import type {
  CreateGmailComposeDraftRequest,
  GmailComposeDraft,
  GmailComposeSendResponse,
} from "@invook/contracts";

import {
  createGmailComposeDraft,
  sendGmailComposeDraft,
} from "./compose-drafts";

export type GmailComposeSendAttempt = {
  request: CreateGmailComposeDraftRequest;
  sendIdempotencyKey: string;
} & ({ phase: "save" } | { phase: "send"; draft: GmailComposeDraft });

interface GmailComposeSendDependencies {
  createDraft: typeof createGmailComposeDraft;
  sendDraft: typeof sendGmailComposeDraft;
}

export async function sendGmailComposeAttempt(
  attempt: GmailComposeSendAttempt,
  onSaved: (
    attempt: Extract<GmailComposeSendAttempt, { phase: "send" }>,
  ) => void,
  dependencies: GmailComposeSendDependencies = {
    createDraft: createGmailComposeDraft,
    sendDraft: sendGmailComposeDraft,
  },
): Promise<GmailComposeSendResponse> {
  const draft =
    attempt.phase === "send"
      ? attempt.draft
      : (await dependencies.createDraft(attempt.request)).draft;
  // Record the provider identity before sending; retries must never create another draft.
  onSaved({ ...attempt, phase: "send", draft });
  return dependencies.sendDraft(draft.providerDraftId, {
    accountId: attempt.request.accountId,
    idempotencyKey: attempt.sendIdempotencyKey,
  });
}
