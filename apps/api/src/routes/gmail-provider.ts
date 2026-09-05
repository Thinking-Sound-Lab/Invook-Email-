import type { FastifyPluginAsync } from "fastify";

import type { SetGmailThreadReadStateRequest } from "@invook/contracts";
import {
  enqueueGmailHistoryCatchup,
  getGmailDraftResourceForUser,
  getGmailMessageMutationContext,
  getGmailThreadMutationContext,
} from "@invook/database";
import {
  deleteGmailDraft,
  GmailApiError,
  modifyGmailMessageLabels,
  trashGmailMessage,
  updateGmailDraft,
  type GmailSystemLabelId,
} from "@invook/gmail";

import { mutationAccessHooks, requireUuidParameter } from "../access";
import { sendJson, sendProblem } from "../responses";
import type { GmailProviderAccess } from "../services/gmail-provider";
import { setGmailThreadReadState } from "../services/gmail-thread-read-state";
import {
  getGmailProviderAccessForAccountRequest,
  sendGmailWriteProblem,
} from "./gmail-provider-access";

type GmailMessageParams = { messageId: string };
type GmailThreadParams = { threadId: string };
type GmailDraftParams = { gmailDraftId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const gmailMessageActions = [
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
  "archive",
  "trash",
] as const;
type GmailMessageAction = (typeof gmailMessageActions)[number];

export function gmailMessageActionMutation(action: GmailMessageAction):
  | { kind: "trash" }
  | {
      kind: "labels";
      changes: {
        addLabelIds?: GmailSystemLabelId[];
        removeLabelIds?: GmailSystemLabelId[];
      };
    } {
  switch (action) {
    case "mark_read":
      return { kind: "labels", changes: { removeLabelIds: ["UNREAD"] } };
    case "mark_unread":
      return { kind: "labels", changes: { addLabelIds: ["UNREAD"] } };
    case "star":
      return { kind: "labels", changes: { addLabelIds: ["STARRED"] } };
    case "unstar":
      return { kind: "labels", changes: { removeLabelIds: ["STARRED"] } };
    case "archive":
      return { kind: "labels", changes: { removeLabelIds: ["INBOX"] } };
    case "trash":
      return { kind: "trash" };
  }
}

function parseGmailMessageAction(body: unknown): GmailMessageAction | null {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "action") ||
    typeof body.action !== "string"
  ) {
    return null;
  }
  return gmailMessageActions.find((action) => action === body.action) ?? null;
}

export function parseGmailThreadReadState(
  body: unknown,
): SetGmailThreadReadStateRequest | null {
  if (
    !isRecord(body) ||
    Object.keys(body).some((key) => key !== "isRead") ||
    typeof body.isRead !== "boolean"
  ) {
    return null;
  }
  return { isRead: body.isRead };
}

async function enqueueProviderCatchup(
  userId: string,
  access: GmailProviderAccess,
) {
  return enqueueGmailHistoryCatchup({
    userId,
    accountId: access.accountId,
    reason: "provider_write",
  });
}

export const registerGmailProviderRoutes: FastifyPluginAsync = async (api) => {
  api.post<{ Params: GmailMessageParams; Body: unknown }>(
    "/v1/gmail/messages/:messageId/actions",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("messageId", "Message ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const action = parseGmailMessageAction(request.body);
      if (!action) {
        await sendProblem(request, reply, 400, "Gmail message action is invalid");
        return;
      }
      const context = await getGmailMessageMutationContext({
        userId: session.userId,
        messageId: request.params.messageId,
      });
      if (!context) {
        await sendProblem(request, reply, 404, "Gmail message not found");
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        context.accountId,
      );
      if (!access) return;
      try {
        const mutation = gmailMessageActionMutation(action);
        if (mutation.kind === "trash") {
          await trashGmailMessage(
            access.accessToken,
            context.providerMessageId,
          );
        } else {
          await modifyGmailMessageLabels(
            access.accessToken,
            context.providerMessageId,
            mutation.changes,
          );
        }
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.put<{ Params: GmailThreadParams; Body: unknown }>(
    "/v1/gmail/threads/:threadId/read-state",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("threadId", "Thread ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const readState = parseGmailThreadReadState(request.body);
      if (!readState) {
        await sendProblem(request, reply, 400, "Gmail thread read state is invalid");
        return;
      }
      const context = await getGmailThreadMutationContext({
        userId: session.userId,
        threadId: request.params.threadId,
      });
      if (!context) {
        await sendProblem(request, reply, 404, "Gmail thread not found");
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        context.accountId,
      );
      if (!access) return;
      try {
        const result = await setGmailThreadReadState({
          userId: session.userId,
          access,
          context,
          isRead: readState.isRead,
        });
        if (result.status === "not_found") {
          await sendProblem(request, reply, 404, "Gmail thread not found");
          return;
        }
        await sendJson(reply, 200, { stepId: result.stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.put<{ Params: GmailDraftParams; Body: unknown }>(
    "/v1/gmail/drafts/:gmailDraftId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("gmailDraftId", "Gmail draft ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const rawRfc2822 =
        isRecord(request.body) && "rawRfc2822" in request.body
          ? request.body.rawRfc2822
          : null;
      if (typeof rawRfc2822 !== "string" || !rawRfc2822.trim()) {
        await sendProblem(request, reply, 400, "Raw RFC 2822 draft is required");
        return;
      }
      const draft = await getGmailDraftResourceForUser({
        userId: session.userId,
        gmailDraftId: request.params.gmailDraftId,
      });
      if (!draft) {
        await sendProblem(request, reply, 404, "Gmail draft not found");
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        draft.accountId,
      );
      if (!access) return;
      try {
        const updated = await updateGmailDraft(
          access.accessToken,
          draft.providerDraftId,
          {
            raw: Buffer.from(rawRfc2822, "utf8"),
            threadId: draft.providerThreadId,
          },
        );
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 200, { draft: updated, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

  api.delete<{ Params: GmailDraftParams }>(
    "/v1/gmail/drafts/:gmailDraftId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("gmailDraftId", "Gmail draft ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const draft = await getGmailDraftResourceForUser({
        userId: session.userId,
        gmailDraftId: request.params.gmailDraftId,
      });
      if (!draft) {
        await sendProblem(request, reply, 404, "Gmail draft not found");
        return;
      }
      const access = await getGmailProviderAccessForAccountRequest(
        request,
        reply,
        draft.accountId,
      );
      if (!access) return;
      try {
        await deleteGmailDraft(access.accessToken, draft.providerDraftId);
        const stepId = await enqueueProviderCatchup(session.userId, access);
        await sendJson(reply, 202, { deleted: true, stepId });
      } catch (error) {
        if (error instanceof GmailApiError) {
          await sendGmailWriteProblem(error, request, reply);
          return;
        }
        throw error;
      }
    },
  );

};
