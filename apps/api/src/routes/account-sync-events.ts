import type { FastifyPluginAsync, FastifyReply } from "fastify";

import type { AccountSyncStatusEvent } from "@invook/contracts";
import {
  getAccountSyncStateForAccount,
  getAccountSyncStateForUser,
  getMailSyncProgressForAccount,
  listenForAccountSyncNotifications,
} from "@invook/database";

import { requireSession } from "../access";
import { sendProblem } from "../responses";

function parseNotification(payload: string): string | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    return typeof value.accountId === "string" ? value.accountId : null;
  } catch {
    return null;
  }
}

type EventResponse = FastifyReply["raw"];

function writeEvent(response: EventResponse, progress: AccountSyncStatusEvent) {
  response.write(`event: account-sync\ndata: ${JSON.stringify(progress)}\n\n`);
}

export const registerAccountSyncEventRoutes: FastifyPluginAsync = async (api) => {
  const streams = new Map<string, Set<EventResponse>>();
  const getDurableProgress = async (
    accountId: string,
  ): Promise<AccountSyncStatusEvent | null> => {
    const [mailSync, syncState] = await Promise.all([
      getMailSyncProgressForAccount({ accountId }),
      getAccountSyncStateForAccount({ accountId }),
    ]);
    return mailSync && syncState
      ? { mailSync, memory: syncState.memory }
      : null;
  };
  const broadcastDurableProgress = async (accountId: string) => {
    const progress = await getDurableProgress(accountId);
    if (!progress) return;
    for (const response of streams.get(accountId) ?? []) {
      if (!response.destroyed && !response.writableEnded) {
        writeEvent(response, progress);
      }
    }
  };
  const stopListening = process.env.DATABASE_URL
    ? await listenForAccountSyncNotifications((payload) => {
        const accountId = parseNotification(payload);
        if (!accountId) return;
        void broadcastDurableProgress(accountId).catch(() => {
          console.error("api: account sync progress notification failed", {
            accountId,
          });
        });
      })
    : null;

  api.addHook("onClose", async () => {
    for (const accountStreams of streams.values()) {
      for (const response of accountStreams) response.end();
    }
    streams.clear();
    await stopListening?.();
  });

  api.get(
    "/v1/account-sync/events",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const account = await getAccountSyncStateForUser({
        userId: session.userId,
      });
      if (!account) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      const [mailSync, syncState] = await Promise.all([
        getMailSyncProgressForAccount({ accountId: account.accountId }),
        getAccountSyncStateForAccount({ accountId: account.accountId }),
      ]);
      if (!mailSync || !syncState) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }

      reply.hijack();
      reply.raw.statusCode = 200;
      reply.raw.setHeader("content-type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("cache-control", "no-cache, no-transform");
      reply.raw.setHeader("connection", "keep-alive");
      reply.raw.setHeader("x-accel-buffering", "no");
      reply.raw.setHeader("x-content-type-options", "nosniff");
      reply.raw.setHeader("x-request-id", request.id);
      reply.raw.flushHeaders();

      const accountStreams = streams.get(account.accountId) ?? new Set();
      accountStreams.add(reply.raw);
      streams.set(account.accountId, accountStreams);
      const removeStream = () => {
        accountStreams.delete(reply.raw);
        if (accountStreams.size === 0) streams.delete(account.accountId);
      };
      request.raw.once("close", removeStream);
      reply.raw.once("close", removeStream);
      writeEvent(reply.raw, {
        mailSync,
        memory: syncState.memory,
      });
    },
  );
};
