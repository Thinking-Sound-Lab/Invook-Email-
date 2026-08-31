import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { recordGmailPushNotification } from "@invook/database";
import { GmailApiError, verifyGoogleIdToken } from "@invook/gmail";

import { getGooglePubSubPushConfiguration } from "../config";
import { sendProblem } from "../responses";

type GooglePubSubPushBody = {
  message?: {
    data?: unknown;
    messageId?: unknown;
    publishTime?: unknown;
  };
  subscription?: unknown;
};

type GmailPushNotification = {
  emailAddress: string;
  historyId: string;
};

type GooglePubSubRouteDependencies = {
  verifyIdentity?: typeof verifyGoogleIdToken;
  recordNotification?: typeof recordGmailPushNotification;
};

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function describePushBody(body: unknown) {
  const bodyRecord = isRecord(body) ? body : null;
  const message = bodyRecord && isRecord(bodyRecord.message)
    ? bodyRecord.message
    : null;
  let decodedDataKeys: string[] = [];
  let decodedEmailAddressType = "unavailable";
  let decodedHistoryIdType = "unavailable";
  if (typeof message?.data === "string") {
    try {
      const decoded = JSON.parse(
        Buffer.from(message.data, "base64").toString("utf8"),
      ) as unknown;
      decodedDataKeys = isRecord(decoded) ? Object.keys(decoded).sort() : [];
      if (isRecord(decoded)) {
        decodedEmailAddressType = typeof decoded.emailAddress;
        decodedHistoryIdType = typeof decoded.historyId;
      }
    } catch {
      decodedDataKeys = [];
    }
  }
  return {
    bodyType: body === null ? "null" : typeof body,
    bodyKeys: bodyRecord ? Object.keys(bodyRecord).sort() : [],
    messageKeys: message ? Object.keys(message).sort() : [],
    dataType: typeof message?.data,
    decodedDataKeys,
    decodedEmailAddressType,
    decodedHistoryIdType,
    messageIdType: typeof message?.messageId,
    publishTimeType: typeof message?.publishTime,
    publishTimeParseResult:
      parsePublishedAt(message?.publishTime) === undefined ? "invalid" : "valid",
    subscriptionType: typeof bodyRecord?.subscription,
  };
}

export function parseGmailNotification(data: unknown): GmailPushNotification | null {
  if (typeof data !== "string" || !data) return null;
  try {
    const decodedJson = Buffer.from(data, "base64").toString("utf8");
    const decoded = JSON.parse(decodedJson) as unknown;
    if (!isRecord(decoded)) return null;
    const emailAddress = decoded.emailAddress;
    let historyId: string | null = null;
    if (typeof decoded.historyId === "string") {
      historyId = decoded.historyId.trim();
    } else if (typeof decoded.historyId === "number") {
      const matches = Array.from(
        decodedJson.matchAll(/"historyId"\s*:\s*([0-9]+)(?=\s*[,}])/g),
      );
      historyId = matches.at(-1)?.[1] ?? null;
    }
    if (
      typeof emailAddress !== "string" ||
      !emailAddress.trim() ||
      !historyId
    ) {
      return null;
    }
    return {
      emailAddress: emailAddress.trim(),
      historyId,
    };
  } catch {
    return null;
  }
}

function parsePublishedAt(value: unknown): Date | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const publishedAt = new Date(value);
  return Number.isFinite(publishedAt.getTime()) ? publishedAt : undefined;
}

export const registerGooglePubSubRoutes: FastifyPluginAsync<
  GooglePubSubRouteDependencies
> = async (api, options) => {
  const verifyIdentity = options.verifyIdentity ?? verifyGoogleIdToken;
  const recordNotification = options.recordNotification ?? recordGmailPushNotification;
  api.post<{ Body: GooglePubSubPushBody | null }>(
    "/google-pubsub",
    {
      onRequest: async (request, reply) => {
        const configuration = getGooglePubSubPushConfiguration();
        if (!configuration) {
          await sendProblem(
            request,
            reply,
            503,
            "Google Pub/Sub push authentication is not configured",
          );
          return;
        }

        const idToken = bearerToken(request);
        if (!idToken) {
          await sendProblem(request, reply, 401, "Google Pub/Sub authentication required");
          return;
        }

        try {
          const identity = await verifyIdentity(idToken, configuration.audience);
          if (identity.email.toLowerCase() !== configuration.serviceAccountEmail) {
            await sendProblem(
              request,
              reply,
              403,
              "Google Pub/Sub service account is not allowed",
            );
            return;
          }
        } catch (error) {
          if (error instanceof GmailApiError) {
            await sendProblem(
              request,
              reply,
              503,
              "Google Pub/Sub identity verification is unavailable",
            );
            return;
          }
          await sendProblem(request, reply, 401, "Google Pub/Sub identity token is invalid");
          return;
        }
      },
    },
    async (request, reply) => {
      const configuration = getGooglePubSubPushConfiguration();
      if (!configuration) return;

      const body = request.body;
      if (!isRecord(body) || !isRecord(body.message)) {
        console.error("api: Google Pub/Sub push envelope is invalid", {
          requestId: request.id,
          ...describePushBody(body),
        });
        await sendProblem(request, reply, 400, "Google Pub/Sub push payload is invalid");
        return;
      }
      if (body.subscription !== configuration.subscription) {
        await sendProblem(request, reply, 403, "Google Pub/Sub subscription is not allowed");
        return;
      }

      const providerEventId = body.message.messageId;
      const notification = parseGmailNotification(body.message.data);
      const publishedAt = parsePublishedAt(body.message.publishTime);
      if (
        typeof providerEventId !== "string" ||
        !providerEventId.trim() ||
        !notification ||
        publishedAt === undefined
      ) {
        console.error("api: Google Pub/Sub push message is invalid", {
          requestId: request.id,
          ...describePushBody(body),
        });
        await sendProblem(request, reply, 400, "Google Pub/Sub push payload is invalid");
        return;
      }

      const result = await recordNotification({
        emailAddress: notification.emailAddress,
        notificationHistoryId: notification.historyId,
      });
      if (result.status === "retry") {
        await sendProblem(request, reply, 503, "Gmail notification admission is busy");
        return;
      }
      await reply.code(204).send();
    },
  );
};
