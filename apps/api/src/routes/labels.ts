import type { FastifyPluginAsync } from "fastify";

import {
  AiConfigurationError,
  classifyStoredThreadLabel,
  ThreadLabelClassificationContractError,
} from "@invook/ai";
import type {
  InvookLabelPreviewMatch,
  LabelHistoryWindowDays,
} from "@invook/contracts";
import {
  createInvookLabel,
  LabelConflictError,
  listInvookLabelPreviewCandidates,
  setInvookLabelEnabled,
  updateInvookLabel,
} from "@invook/database";

import { mutationAccessHooks, requireUuidParameter } from "../access";
import { parseRequiredMailboxAccountId } from "../mailbox-account-scope";
import { sendJson, sendProblem } from "../responses";

type LabelParams = {
  labelId: string;
};

class LabelPreviewModelError extends Error {
  constructor() {
    super("The label preview model request failed.");
    this.name = "LabelPreviewModelError";
  }
}

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function parseLabelDefinition(body: unknown): {
  name: string;
  description: string;
} | null {
  const name = body && typeof body === "object" && "name" in body
    ? body.name
    : null;
  const description =
    body && typeof body === "object" && "description" in body
      ? body.description
      : null;
  if (
    typeof name !== "string" ||
    !normalize(name) ||
    typeof description !== "string" ||
    !normalize(description)
  ) {
    return null;
  }
  return { name: normalize(name), description: normalize(description) };
}

function parseHistoryWindow(body: unknown): LabelHistoryWindowDays | null {
  if (!body || typeof body !== "object" || !("applyToPastDays" in body)) {
    return null;
  }
  const value = body.applyToPastDays;
  return value === 7 || value === 30 || value === 90 ? value : null;
}

function hasInvalidHistoryWindow(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("applyToPastDays" in body)) {
    return false;
  }
  const value = body.applyToPastDays;
  return value !== null && value !== 7 && value !== 30 && value !== 90;
}

function parseEnabledState(body: unknown): boolean | null {
  if (!body || typeof body !== "object" || !("isEnabled" in body)) {
    return null;
  }
  return typeof body.isEnabled === "boolean" ? body.isEnabled : null;
}

async function previewLabelMatches(input: {
  userId: string;
  accountId: string;
  name: string;
  description: string;
}): Promise<{ scannedThreadCount: number; matches: InvookLabelPreviewMatch[] }> {
  const candidates = await listInvookLabelPreviewCandidates({
    userId: input.userId,
    accountId: input.accountId,
    limit: 100,
  });
  const matches: InvookLabelPreviewMatch[] = [];
  try {
    for (let index = 0; index < candidates.length; index += 5) {
      const results = await Promise.all(
        candidates.slice(index, index + 5).map(async (candidate) => {
          const noMatchLabelId = `preview-no-match:${candidate.threadId}`;
          const classification = await classifyStoredThreadLabel({
            thread: {
              subject: candidate.subject,
              messages: candidate.messages.map((message) => ({
                subject: message.subject,
                sender: message.sender.raw,
                recipients: message.recipients,
                bodyText: message.bodyText,
                sentAt: message.sentAt.toISOString(),
              })),
            },
            labelDefinitions: [{
              id: "preview",
              name: input.name,
              description: input.description,
              definitionVersion: 1,
            }],
            fallbackLabelId: noMatchLabelId,
          });
          return {
            candidate,
            matched: classification.labelId === "preview",
            confidence: classification.confidence,
          };
        }),
      );
      for (const result of results) {
        if (!result.matched) continue;
        matches.push({
          threadId: result.candidate.threadId,
          sender: result.candidate.sender.raw,
          subject: result.candidate.subject,
          sentAt: result.candidate.sentAt.toISOString(),
          confidence: result.confidence,
        });
      }
    }
  } catch (error) {
    if (
      error instanceof AiConfigurationError ||
      error instanceof ThreadLabelClassificationContractError
    ) {
      throw error;
    }
    throw new LabelPreviewModelError();
  }
  return { scannedThreadCount: candidates.length, matches };
}

export const registerLabelRoutes: FastifyPluginAsync = async (api) => {
  api.post<{ Body: unknown }>(
    "/preview",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const definition = parseLabelDefinition(request.body);
      const accountId =
        request.body && typeof request.body === "object" && "accountId" in request.body
          ? parseRequiredMailboxAccountId(request.body.accountId)
          : null;
      if (!definition || !accountId) {
        await sendProblem(
          request,
          reply,
          400,
          "Label name and description are required",
        );
        return;
      }
      try {
        const preview = await previewLabelMatches({
          userId: session.userId,
          accountId,
          ...definition,
        });
        await sendJson(reply, 200, preview);
      } catch (error) {
        if (error instanceof AiConfigurationError) {
          await sendProblem(request, reply, 503, "Label preview model is unavailable");
          return;
        }
        if (error instanceof ThreadLabelClassificationContractError) {
          await sendProblem(request, reply, 502, "Label preview returned an invalid result");
          return;
        }
        if (error instanceof LabelPreviewModelError) {
          await sendProblem(request, reply, 502, "Label preview could not be completed");
          return;
        }
        throw error;
      }
    },
  );

  api.post<{ Body: unknown }>(
    "/",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const definition = parseLabelDefinition(request.body);
      const accountId =
        request.body && typeof request.body === "object" && "accountId" in request.body
          ? parseRequiredMailboxAccountId(request.body.accountId)
          : null;
      if (!definition || !accountId) {
        await sendProblem(
          request,
          reply,
          400,
          "Label name and description are required",
        );
        return;
      }
      if (hasInvalidHistoryWindow(request.body)) {
        await sendProblem(
          request,
          reply,
          400,
          "Past-email window must be 7, 30, or 90 days",
        );
        return;
      }

      try {
        const label = await createInvookLabel({
          userId: session.userId,
          accountId,
          ...definition,
          applyToPastDays: parseHistoryWindow(request.body),
        });
        if (!label) {
          await sendProblem(
            request,
            reply,
            404,
            "Connected Gmail account not found",
          );
          return;
        }
        const { historicalAnalysis, ...serializedLabel } = label;
        await sendJson(reply, 201, {
          label: serializedLabel,
          historicalAnalysis,
        });
      } catch (error) {
        if (error instanceof LabelConflictError) {
          await sendProblem(request, reply, 409, error.message);
          return;
        }
        throw error;
      }
    },
  );

  api.patch<{ Params: LabelParams; Body: unknown }>(
    "/:labelId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("labelId", "Label ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const definition = parseLabelDefinition(request.body);
      if (!definition) {
        await sendProblem(
          request,
          reply,
          400,
          "Label name and description are required",
        );
        return;
      }

      try {
        const label = await updateInvookLabel({
          userId: session.userId,
          labelId: request.params.labelId,
          ...definition,
        });
        if (!label) {
          await sendProblem(request, reply, 404, "Custom label not found");
          return;
        }
        await sendJson(reply, 200, { label });
      } catch (error) {
        if (error instanceof LabelConflictError) {
          await sendProblem(request, reply, 409, error.message);
          return;
        }
        throw error;
      }
    },
  );

  api.patch<{ Params: LabelParams; Body: unknown }>(
    "/:labelId/enabled",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("labelId", "Label ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const isEnabled = parseEnabledState(request.body);
      if (isEnabled === null || hasInvalidHistoryWindow(request.body)) {
        await sendProblem(
          request,
          reply,
          400,
          "Enabled state and past-email window must be valid",
        );
        return;
      }
      try {
        const result = await setInvookLabelEnabled({
          userId: session.userId,
          labelId: request.params.labelId,
          isEnabled,
          applyToPastDays: parseHistoryWindow(request.body),
        });
        if (!result) {
          await sendProblem(request, reply, 404, "Label not found");
          return;
        }
        const { historicalAnalysis, ...label } = result;
        await sendJson(reply, 200, { label, historicalAnalysis });
      } catch (error) {
        if (error instanceof LabelConflictError) {
          await sendProblem(request, reply, 409, error.message);
          return;
        }
        throw error;
      }
    },
  );
};
