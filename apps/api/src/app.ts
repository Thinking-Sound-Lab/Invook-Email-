import { performance } from "node:perf_hooks";

import fastifyCookie from "@fastify/cookie";
import Fastify, { type FastifyRequest } from "fastify";
import { v4 as uuidv4 } from "uuid";

import {
  createAuthService,
  type AuthService,
} from "./auth/auth-service";
import { registerAuthRoutes } from "./routes/auth";
import {
  registerAttachmentRoutes,
  type AttachmentRouteDependencies,
} from "./routes/attachments";
import { registerBatchWebhookRoutes } from "./routes/batch-webhook";
import { registerComposeDraftRoutes } from "./routes/compose-drafts";
import { registerGmailProviderRoutes } from "./routes/gmail-provider";
import { registerGmailConnectionRoutes } from "./routes/gmail-connections";
import { registerHealthRoutes } from "./routes/health";
import { registerAccountSyncEventRoutes } from "./routes/account-sync-events";
import {
  registerLabelRoutes,
  type LabelRouteDependencies,
} from "./routes/labels";
import { registerGooglePubSubRoutes } from "./routes/google-pubsub";
import { registerMailboxEventRoutes } from "./routes/mailbox-events";
import { registerMailSearchRoutes } from "./routes/mail-search";
import { registerMailboxRoutes } from "./routes/mailbox";
import { registerSessionRoutes } from "./routes/session";
import { registerThreadLabelRoutes } from "./routes/thread-labels";
import { InvalidJsonBodyError, sendProblem } from "./responses";

const MAXIMUM_REQUEST_BODY_BYTES = 65_536;

function isInvalidBodyError(error: unknown): boolean {
  return (
    error instanceof InvalidJsonBodyError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "FST_ERR_CTP_BODY_TOO_LARGE")
  );
}

export async function buildApi(options: {
  attachmentRoutes?: AttachmentRouteDependencies;
  auth?: AuthService;
  labelRoutes?: LabelRouteDependencies;
} = {}) {
  const api = Fastify({
    bodyLimit: MAXIMUM_REQUEST_BODY_BYTES,
    exposeHeadRoutes: false,
    genReqId: () => uuidv4(),
    logger: false,
    requestIdHeader: "x-request-id",
    routerOptions: {
      caseSensitive: true,
      ignoreTrailingSlash: true,
    },
  });

  api.decorateRequest("invookSession", null);
  api.decorateRequest("invookStartedAt", 0);
  api.decorate("invookAuth", options.auth ?? createAuthService());
  await api.register(fastifyCookie);

  api.addHook("onRequest", async (request, reply) => {
    request.invookStartedAt = performance.now();
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-request-id", request.id);
  });
  api.addHook("onSend", async (request, reply, payload) => {
    const duration = Math.max(0, performance.now() - request.invookStartedAt);
    reply.header("server-timing", `api;dur=${duration.toFixed(1)}`);
    return payload;
  });

  api.removeAllContentTypeParsers();
  api.addContentTypeParser(
    "*",
    { parseAs: "string" },
    async (_request: FastifyRequest, body: string) => {
      if (!body) return null;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new InvalidJsonBodyError();
      }
    },
  );

  await api.register(registerBatchWebhookRoutes, { prefix: "/v1/webhooks" });
  await api.register(registerGooglePubSubRoutes, { prefix: "/v1/webhooks" });
  await api.register(registerHealthRoutes);
  await api.register(registerAuthRoutes);
  await api.register(registerSessionRoutes);
  await api.register(registerGmailConnectionRoutes);
  await api.register(registerAttachmentRoutes(options.attachmentRoutes));
  await api.register(registerAccountSyncEventRoutes);
  await api.register(registerMailboxEventRoutes);
  await api.register(registerMailboxRoutes);
  await api.register(registerMailSearchRoutes);
  await api.register(registerLabelRoutes, {
    prefix: "/v1/labels",
    ...options.labelRoutes,
  });
  await api.register(registerThreadLabelRoutes, { prefix: "/v1/threads" });
  await api.register(registerComposeDraftRoutes);
  await api.register(registerGmailProviderRoutes);

  api.setNotFoundHandler(async (request, reply) => {
    await sendProblem(request, reply, 404, "Route not found");
  });

  api.setErrorHandler(async (error, request, reply) => {
    if (isInvalidBodyError(error)) {
      await sendProblem(request, reply, 400, "Invalid JSON request body");
      return;
    }

    const normalizedError =
      error instanceof Error ? error : new Error("Unknown API failure");
    console.error("api: request failed", {
      requestId: request.id,
      method: request.method,
      path: request.url.split("?", 1)[0],
      name: normalizedError.name,
    });
    if (!reply.raw.headersSent) {
      await sendProblem(request, reply, 500, "Internal server error");
      return;
    }
    reply.raw.end();
  });

  return api;
}
