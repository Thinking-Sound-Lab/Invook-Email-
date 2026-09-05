import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import { getBatchWebhookSecret } from "@invook/ai";
import { enqueueBatchEvent } from "@invook/database";
import { Webhook, WebhookVerificationError } from "standardwebhooks";

import { sendJson, sendProblem } from "../responses";

const supportedEvents = new Set([
  "batch.completed",
  "batch.failed",
  "batch.cancelled",
  "batch.expired",
]);

function headerValue(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

async function handleBatchWebhook(
  request: FastifyRequest<{ Body: Buffer | undefined }>,
  reply: FastifyReply,
) {
  const signingSecret = getBatchWebhookSecret();
  if (!signingSecret) {
    await sendProblem(
      request,
      reply,
      503,
      "OpenAI webhook is not configured",
    );
    return;
  }

  const webhookId = headerValue(request, "webhook-id");
  const webhookTimestamp = headerValue(request, "webhook-timestamp");
  const webhookSignature = headerValue(request, "webhook-signature");
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    await sendProblem(
      request,
      reply,
      400,
      "OpenAI webhook signature is missing",
    );
    return;
  }

  let event: unknown;
  try {
    event = new Webhook(signingSecret).verify(request.body ?? Buffer.alloc(0), {
      "webhook-id": webhookId,
      "webhook-timestamp": webhookTimestamp,
      "webhook-signature": webhookSignature,
    });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      await sendProblem(
        request,
        reply,
        400,
        "OpenAI webhook signature is invalid",
      );
      return;
    }
    throw error;
  }

  if (!event || typeof event !== "object") {
    await sendProblem(
      request,
      reply,
      400,
      "OpenAI webhook payload is invalid",
    );
    return;
  }
  const eventType = "type" in event ? event.type : undefined;
  const data = "data" in event ? event.data : undefined;
  if (
    typeof eventType !== "string" ||
    !supportedEvents.has(eventType) ||
    !data ||
    typeof data !== "object" ||
    !("id" in data) ||
    typeof data.id !== "string" ||
    !data.id.trim()
  ) {
    await sendProblem(
      request,
      reply,
      400,
      "OpenAI webhook event is unsupported",
    );
    return;
  }

  const queued = await enqueueBatchEvent({
    webhookId,
    eventType,
    providerBatchId: data.id,
  });
  if (!queued) {
    await sendProblem(
      request,
      reply,
      409,
      "OpenAI batch submission is not ready",
    );
    return;
  }
  await sendJson(reply, 202, { received: true });
}

export const registerBatchWebhookRoutes: FastifyPluginAsync = async (api) => {
  api.removeAllContentTypeParsers();
  api.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    async (_request: FastifyRequest, body: Buffer) => body,
  );

  api.post<{ Body: Buffer | undefined }>("/openai", async (request, reply) => {
    await handleBatchWebhook(request, reply);
  });
};
