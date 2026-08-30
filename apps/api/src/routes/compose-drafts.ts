import type { FastifyPluginAsync } from "fastify";
import { validate as validateUuid } from "uuid";

import {
  validateGmailComposeDraftFields,
  type CreateGmailComposeDraftRequest,
  type GmailComposeDraftSource,
  type SendGmailComposeDraftRequest,
} from "@invook/contracts";
import {
  GmailDraftWriteConflictError,
  markGmailAccountReconnectRequired,
} from "@invook/database";
import {
  GmailApiError,
  GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
  isGoogleReauthenticationRequired,
} from "@invook/gmail";

import { mutationAccessHooks } from "../access";
import { sendJson, sendProblem } from "../responses";
import {
  GmailDraftWritePendingError,
  GmailForwardContextUnavailableError,
  GmailReplyContextUnavailableError,
  saveComposeDraft,
} from "../services/compose-drafts";
import {
  GmailDraftSendPendingError,
  sendComposeDraft,
} from "../services/compose-send";
import {
  getGmailProviderAccessForAccountRequest,
  sendGmailWriteProblem,
} from "./gmail-provider-access";

type ProviderDraftParams = { providerDraftId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseGmailComposeDraftRequest(
  body: unknown,
): CreateGmailComposeDraftRequest | null {
  if (!isRecord(body)) return null;
  const allowedKeys = new Set([
    "accountId",
    "idempotencyKey",
    "recipients",
    "ccRecipients",
    "bccRecipients",
    "replyToMessageId",
    "forwardOfMessageId",
    "subject",
    "body",
  ]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof body.idempotencyKey !== "string" ||
    !validateUuid(body.idempotencyKey) ||
    typeof body.accountId !== "string" ||
    !validateUuid(body.accountId) ||
    !Array.isArray(body.recipients) ||
    body.recipients.some((recipient) => typeof recipient !== "string") ||
    typeof body.subject !== "string" ||
    typeof body.body !== "string"
  ) {
    return null;
  }
  if (
    (body.replyToMessageId !== undefined &&
      (typeof body.replyToMessageId !== "string" ||
        !validateUuid(body.replyToMessageId))) ||
    (body.forwardOfMessageId !== undefined &&
      (typeof body.forwardOfMessageId !== "string" ||
        !validateUuid(body.forwardOfMessageId))) ||
    (body.replyToMessageId !== undefined &&
      body.forwardOfMessageId !== undefined) ||
    [body.ccRecipients, body.bccRecipients].some(
      (recipients) =>
        recipients !== undefined &&
        (!Array.isArray(recipients) ||
          recipients.some((recipient) => typeof recipient !== "string")),
    )
  )
    return null;
  const source: GmailComposeDraftSource =
    typeof body.forwardOfMessageId === "string"
      ? { forwardOfMessageId: body.forwardOfMessageId }
      : typeof body.replyToMessageId === "string"
        ? { replyToMessageId: body.replyToMessageId }
        : {};
  const validation = validateGmailComposeDraftFields(
    {
      recipients: body.recipients.filter(
        (recipient): recipient is string => typeof recipient === "string",
      ),
      subject: body.subject,
      body: body.body,
      ...(Array.isArray(body.ccRecipients)
        ? {
            ccRecipients: body.ccRecipients.filter(
              (recipient): recipient is string => typeof recipient === "string",
            ),
          }
        : {}),
      ...(Array.isArray(body.bccRecipients)
        ? {
            bccRecipients: body.bccRecipients.filter(
              (recipient): recipient is string => typeof recipient === "string",
            ),
          }
        : {}),
    },
    source,
  );
  if (!validation.valid) return null;
  return {
    accountId: body.accountId,
    idempotencyKey: body.idempotencyKey,
    ...validation.fields,
    ...source,
  };
}

export function parseGmailComposeSendRequest(
  body: unknown,
): SendGmailComposeDraftRequest | null {
  if (
    !isRecord(body) ||
    Object.keys(body).some(
      (key) => key !== "accountId" && key !== "idempotencyKey",
    ) ||
    typeof body.accountId !== "string" ||
    !validateUuid(body.accountId) ||
    typeof body.idempotencyKey !== "string" ||
    !validateUuid(body.idempotencyKey)
  ) {
    return null;
  }
  return { accountId: body.accountId, idempotencyKey: body.idempotencyKey };
}

function isProviderDraftId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

async function sendComposeDraftError(
  error: unknown,
  accountId: string,
  request: Parameters<typeof sendProblem>[0],
  reply: Parameters<typeof sendProblem>[1],
): Promise<boolean> {
  if (error instanceof GmailForwardContextUnavailableError) {
    await sendProblem(
      request,
      reply,
      404,
      "Forwarded message is unavailable for this Gmail account",
    );
    return true;
  }
  if (error instanceof GmailReplyContextUnavailableError) {
    await sendProblem(
      request,
      reply,
      404,
      "Reply message is unavailable for this Gmail account",
    );
    return true;
  }
  if (error instanceof GmailDraftWriteConflictError) {
    await sendProblem(
      request,
      reply,
      409,
      "Idempotency key conflicts with another draft save",
    );
    return true;
  }
  if (error instanceof GmailDraftWritePendingError) {
    await sendProblem(
      request,
      reply,
      409,
      "Previous Gmail draft save is still being resolved",
    );
    return true;
  }
  if (error instanceof GmailDraftSendPendingError) {
    await sendProblem(
      request,
      reply,
      409,
      "Previous Gmail draft send is still being resolved",
    );
    return true;
  }
  if (error instanceof GmailApiError) {
    if (isGoogleReauthenticationRequired(error)) {
      await markGmailAccountReconnectRequired({
        accountId,
        errorCode: GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
      });
      await sendProblem(
        request,
        reply,
        409,
        "Gmail account must be reconnected",
      );
      return true;
    }
    await sendGmailWriteProblem(error, request, reply);
    return true;
  }
  return false;
}

export const registerComposeDraftRoutes: FastifyPluginAsync = async (api) => {
  api.post<{ Body: unknown }>(
    "/v1/gmail/compose-drafts",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const draft = parseGmailComposeDraftRequest(request.body);
      if (!draft) {
        await sendProblem(
          request,
          reply,
          400,
          "Gmail compose draft input is invalid",
        );
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        draft.accountId,
      );
      if (!access) return;
      try {
        const result = await saveComposeDraft({
          userId: session.userId,
          access,
          operation: "create",
          idempotencyKey: draft.idempotencyKey,
          source: draft.forwardOfMessageId
            ? { forwardOfMessageId: draft.forwardOfMessageId }
            : { replyToMessageId: draft.replyToMessageId },
          fields: {
            recipients: draft.recipients,
            ccRecipients: draft.ccRecipients,
            bccRecipients: draft.bccRecipients,
            subject: draft.subject,
            body: draft.body,
          },
        });
        await sendJson(reply, 201, result);
      } catch (error) {
        if (
          await sendComposeDraftError(error, access.accountId, request, reply)
        )
          return;
        throw error;
      }
    },
  );

  api.put<{ Params: ProviderDraftParams; Body: unknown }>(
    "/v1/gmail/compose-drafts/:providerDraftId",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (!isProviderDraftId(request.params.providerDraftId)) {
        await sendProblem(
          request,
          reply,
          400,
          "Gmail provider draft ID is invalid",
        );
        return;
      }
      const draft = parseGmailComposeDraftRequest(request.body);
      if (!draft) {
        await sendProblem(
          request,
          reply,
          400,
          "Gmail compose draft input is invalid",
        );
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        draft.accountId,
      );
      if (!access) return;
      try {
        const result = await saveComposeDraft({
          userId: session.userId,
          access,
          operation: "update",
          idempotencyKey: draft.idempotencyKey,
          source: draft.forwardOfMessageId
            ? { forwardOfMessageId: draft.forwardOfMessageId }
            : { replyToMessageId: draft.replyToMessageId },
          fields: {
            recipients: draft.recipients,
            ccRecipients: draft.ccRecipients,
            bccRecipients: draft.bccRecipients,
            subject: draft.subject,
            body: draft.body,
          },
          providerDraftId: request.params.providerDraftId,
        });
        await sendJson(reply, 200, result);
      } catch (error) {
        if (
          await sendComposeDraftError(error, access.accountId, request, reply)
        )
          return;
        throw error;
      }
    },
  );

  api.post<{ Params: ProviderDraftParams; Body: unknown }>(
    "/v1/gmail/compose-drafts/:providerDraftId/send",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (!isProviderDraftId(request.params.providerDraftId)) {
        await sendProblem(
          request,
          reply,
          400,
          "Gmail provider draft ID is invalid",
        );
        return;
      }
      const send = parseGmailComposeSendRequest(request.body);
      if (!send) {
        await sendProblem(
          request,
          reply,
          400,
          "Gmail compose send input is invalid",
        );
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        send.accountId,
      );
      if (!access) return;
      try {
        const result = await sendComposeDraft({
          userId: session.userId,
          access,
          idempotencyKey: send.idempotencyKey,
          providerDraftId: request.params.providerDraftId,
        });
        await sendJson(reply, 200, result);
      } catch (error) {
        if (
          await sendComposeDraftError(error, access.accountId, request, reply)
        )
          return;
        throw error;
      }
    },
  );
};
