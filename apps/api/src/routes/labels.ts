import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { validate as validateUuid } from "uuid";

import {
  AiConfigurationError,
  classifyStoredThreadLabel,
  createStoredThreadLabelInputHash,
  ThreadLabelClassificationContractError,
} from "@invook/ai";
import type {
  InvookLabelPreviewResponse,
  LabelHistoryWindowDays,
} from "@invook/contracts";
import {
  createLabelPreviewReceipt,
  createInvookLabel,
  deleteExpiredLabelPreviewReceipts,
  getInvookLabelPreviewContext,
  LabelConflictError,
  LabelMutationError,
  LabelPreviewReceiptConflictError,
  setInvookLabelEnabled,
  updateInvookLabel,
} from "@invook/database";

import { mutationAccessHooks, requireUuidParameter } from "../access";
import { parseRequiredMailboxAccountId } from "../mailbox-account-scope";
import { sendJson, sendProblem } from "../responses";

type LabelParams = {
  labelId: string;
};

export type LabelRouteDependencies = {
  createLabel?: typeof createInvookLabel;
  previewLabel?: typeof previewLabelMatches;
};

class LabelPreviewModelError extends Error {
  constructor() {
    super("The label preview model request failed.");
    this.name = "LabelPreviewModelError";
  }
}

async function sendLabelMutationFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  error: LabelMutationError,
): Promise<void> {
  const causeName = error.cause instanceof Error
    ? error.cause.name
    : "UnknownError";
  console.error("api: label mutation failed", {
    requestId: request.id,
    method: request.method,
    path: request.url.split("?", 1)[0],
    operation: error.operation,
    causeName,
  });
  await sendProblem(
    request,
    reply,
    503,
    "Label change could not be completed",
  );
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

function parsePreviewReceiptId(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("previewReceiptId" in body)) {
    return null;
  }
  return typeof body.previewReceiptId === "string"
    ? body.previewReceiptId
    : null;
}

function hasInvalidPreviewReceiptId(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("previewReceiptId" in body)) {
    return false;
  }
  return (
    typeof body.previewReceiptId !== "string" ||
    !validateUuid(body.previewReceiptId)
  );
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
}): Promise<InvookLabelPreviewResponse> {
  await deleteExpiredLabelPreviewReceipts();
  const context = await getInvookLabelPreviewContext({
    userId: input.userId,
    accountId: input.accountId,
    limit: 100,
  });
  if (!context) {
    return {
      previewReceiptId: null,
      expiresAt: null,
      scannedThreadCount: 0,
      matches: [],
    };
  }
  const outcomes: Array<{
    candidate: (typeof context.candidates)[number];
    classifierInputHash: string;
    matched: boolean;
    confidence: number;
    modelId: string;
  }> = [];
  try {
    for (let index = 0; index < context.candidates.length; index += 5) {
      const results = await Promise.all(
        context.candidates.slice(index, index + 5).map(async (candidate) => {
          const noMatchLabelId = `preview-no-match:${candidate.threadId}`;
          const thread = {
            subject: candidate.subject,
            messages: candidate.messages.map((message) => ({
              subject: message.subject,
              sender: message.sender.raw,
              recipients: message.recipients,
              bodyText: message.bodyText,
              sentAt: message.sentAt.toISOString(),
            })),
          };
          const classification = await classifyStoredThreadLabel({
            thread,
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
            classifierInputHash: createStoredThreadLabelInputHash(thread),
            matched: classification.labelId === "preview",
            confidence: classification.confidence,
            modelId: classification.modelId,
          };
        }),
      );
      outcomes.push(...results);
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
  const receipt = await createLabelPreviewReceipt({
    userId: input.userId,
    accountId: context.accountId,
    name: input.name,
    description: input.description,
    results: outcomes.map((outcome) => ({
      threadId: outcome.candidate.threadId,
      classifierInputHash: outcome.classifierInputHash,
      matched: outcome.matched,
      confidence: outcome.confidence,
      modelId: outcome.modelId,
    })),
  });
  return {
    previewReceiptId: receipt.id,
    expiresAt: receipt.expiresAt.toISOString(),
    scannedThreadCount: outcomes.length,
    matches: outcomes.flatMap((outcome) =>
      outcome.matched
        ? [{
            threadId: outcome.candidate.threadId,
            sender: outcome.candidate.sender.raw,
            subject: outcome.candidate.subject,
            sentAt: outcome.candidate.sentAt.toISOString(),
            confidence: outcome.confidence,
          }]
        : [],
    ),
  };
}

export const registerLabelRoutes: FastifyPluginAsync<
  LabelRouteDependencies
> = async (api, dependencies) => {
  const createLabel = dependencies.createLabel ?? createInvookLabel;
  const previewLabel = dependencies.previewLabel ?? previewLabelMatches;
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
        const preview = await previewLabel({
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
      if (hasInvalidPreviewReceiptId(request.body)) {
        await sendProblem(request, reply, 400, "Label preview ID must be valid");
        return;
      }

      try {
        const label = await createLabel({
          userId: session.userId,
          accountId,
          ...definition,
          applyToPastDays: parseHistoryWindow(request.body),
          previewReceiptId: parsePreviewReceiptId(request.body),
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
        if (error instanceof LabelPreviewReceiptConflictError) {
          await sendProblem(request, reply, 409, error.message);
          return;
        }
        if (error instanceof LabelMutationError) {
          await sendLabelMutationFailure(request, reply, error);
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
        if (error instanceof LabelMutationError) {
          await sendLabelMutationFailure(request, reply, error);
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
        if (error instanceof LabelMutationError) {
          await sendLabelMutationFailure(request, reply, error);
          return;
        }
        throw error;
      }
    },
  );
};
