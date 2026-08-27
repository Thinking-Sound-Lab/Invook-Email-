import type { FastifyPluginAsync, FastifyReply } from "fastify";

import type {
  MailboxChangeEvent,
  MailboxStreamReadyEvent,
} from "@invook/contracts";
import {
  getMailboxChangeEvent,
  getMailboxEventRecoveryContextForUser,
  listenForMailboxChangeNotifications,
} from "@invook/database";

import { requireSession } from "../access";
import {
  createSafeMailboxInvalidation,
  parseMailboxNotification,
  projectMailboxChangeEvent,
} from "../mailbox-event-projection";
import { MailboxListenerHealth } from "../mailbox-listener-health";

type EventResponse = FastifyReply["raw"];

interface MailboxEventStream {
  isReady: boolean;
  response: EventResponse;
}

function isOpen(stream: MailboxEventStream): boolean {
  return !stream.response.destroyed && !stream.response.writableEnded;
}

function writeEvent(
  response: EventResponse,
  eventName: "mailbox" | "mailbox-ready",
  payload: MailboxChangeEvent | MailboxStreamReadyEvent,
): void {
  response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export const registerMailboxEventRoutes: FastifyPluginAsync = async (api) => {
  const health = new MailboxListenerHealth();
  const streams = new Map<string, Set<MailboxEventStream>>();
  let delivery = Promise.resolve();

  function removeStream(userId: string, stream: MailboxEventStream): void {
    const userStreams = streams.get(userId);
    userStreams?.delete(stream);
    if (userStreams?.size === 0) streams.delete(userId);
  }

  function closeUserStreams(userId: string): void {
    for (const stream of streams.get(userId) ?? []) stream.response.end();
    streams.delete(userId);
  }

  function closeAllStreams(): void {
    for (const userStreams of streams.values()) {
      for (const stream of userStreams) stream.response.end();
    }
    streams.clear();
  }

  function deliverToUser(userId: string, event: MailboxChangeEvent): void {
    for (const stream of streams.get(userId) ?? []) {
      if (!isOpen(stream)) continue;
      if (!stream.isReady) {
        stream.response.end();
        continue;
      }
      writeEvent(stream.response, "mailbox", event);
    }
  }

  const stopListening = process.env.DATABASE_URL
    ? await listenForMailboxChangeNotifications({
        onSubscriptionLost: () => {
          health.subscriptionLost();
          closeAllStreams();
        },
        onSubscribed: () => {
          const subscription = health.subscriptionEstablished();
          if (subscription.isRecovery) closeAllStreams();
        },
        onNotification: (payload) => {
          delivery = delivery
            .then(async () => {
              const notification = parseMailboxNotification(payload);
              if (!notification) {
                health.invalidateAll();
                closeAllStreams();
                api.log.error("malformed mailbox notification invalidated all streams");
                return;
              }
              try {
                const storedEvent = await getMailboxChangeEvent(notification.eventId);
                if (!storedEvent) {
                  health.invalidateUser(notification.userId);
                  closeUserStreams(notification.userId);
                  return;
                }
                if (
                  storedEvent.userId !== notification.userId ||
                  storedEvent.accountId !== notification.accountId
                ) {
                  health.invalidateAll();
                  closeAllStreams();
                  api.log.error(
                    { eventId: notification.eventId },
                    "mailbox notification scope did not match its durable event",
                  );
                  return;
                }
                const event =
                  projectMailboxChangeEvent(storedEvent) ??
                  createSafeMailboxInvalidation(storedEvent);
                deliverToUser(storedEvent.userId, event);
              } catch (error: unknown) {
                health.invalidateUser(notification.userId);
                closeUserStreams(notification.userId);
                const normalizedError =
                  error instanceof Error
                    ? error
                    : new Error("Unknown mailbox event lookup failure");
                api.log.error(
                  {
                    eventId: notification.eventId,
                    name: normalizedError.name,
                    message: normalizedError.message,
                  },
                  "mailbox event lookup failed; scoped streams were invalidated",
                );
              }
            })
            .catch((error: unknown) => {
              health.invalidateAll();
              closeAllStreams();
              const normalizedError =
                error instanceof Error
                  ? error
                  : new Error("Unknown mailbox event delivery failure");
              api.log.error(
                { name: normalizedError.name, message: normalizedError.message },
                "mailbox event delivery failed; all streams were invalidated",
              );
            });
        },
      })
    : null;

  api.addHook("onClose", async () => {
    closeAllStreams();
    await stopListening?.();
    await delivery;
  });

  api.get(
    "/v1/mailbox/events",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;

      reply.hijack();
      reply.raw.statusCode = health.hasSubscription ? 200 : 503;
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache, no-transform");
      reply.raw.setHeader("connection", "keep-alive");
      reply.raw.setHeader("x-accel-buffering", "no");
      reply.raw.setHeader("x-content-type-options", "nosniff");
      reply.raw.setHeader("x-request-id", request.id);
      reply.raw.flushHeaders();
      if (!health.hasSubscription) {
        reply.raw.end();
        return;
      }

      const generation = health.generation;
      const stream: MailboxEventStream = { isReady: false, response: reply.raw };
      const userStreams = streams.get(session.userId) ?? new Set();
      userStreams.add(stream);
      streams.set(session.userId, userStreams);
      const remove = () => removeStream(session.userId, stream);
      request.raw.once("close", remove);
      reply.raw.once("close", remove);

      try {
        const recovery = await getMailboxEventRecoveryContextForUser(session.userId);
        if (
          !recovery ||
          !isOpen(stream) ||
          !health.recordCanonicalRecovery(session.userId, generation)
        ) {
          health.invalidateUser(session.userId);
          remove();
          reply.raw.end();
          return;
        }
        stream.isReady = true;
        writeEvent(stream.response, "mailbox-ready", {
          type: "mailbox_stream_ready",
          accountIds: recovery.accountIds,
        });
      } catch (error: unknown) {
        health.invalidateUser(session.userId);
        closeUserStreams(session.userId);
        const normalizedError =
          error instanceof Error
            ? error
            : new Error("Unknown mailbox stream recovery failure");
        request.log.error(
          { name: normalizedError.name, message: normalizedError.message },
          "mailbox stream recovery read failed",
        );
      }
    },
  );
};
