import type { FastifyPluginAsync } from "fastify";

import { createMailAgent, isAiConfigured } from "@invook/ai";
import {
  getMailboxThreadForAgent,
  listMailboxThreadAttachments,
  resolveMailboxAccountIds,
} from "@invook/database";
import { pipeAgentUIStreamToResponse } from "ai";

import { mutationAccessHooks, requireSession } from "../access";
import {
  type MailboxAccountQuery,
  parseMailboxAccountScope,
} from "../mailbox-account-scope";
import { sendJson, sendProblem } from "../responses";
import { generateDraftForUser } from "../services/drafts";
import { queryMailboxForUser } from "../services/mailbox-query";
import { searchMailForUser } from "../services/search";

type SearchQuery = MailboxAccountQuery & { q?: unknown };

function parseMessages(body: unknown) {
  const suppliedMessages =
    body && typeof body === "object" && "messages" in body
      ? body.messages
      : undefined;
  if (!Array.isArray(suppliedMessages)) return [];
  return suppliedMessages.flatMap((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("id" in message) ||
      typeof message.id !== "string" ||
      !("role" in message) ||
      (message.role !== "user" && message.role !== "assistant") ||
      !("parts" in message) ||
      !Array.isArray(message.parts)
    ) {
      return [];
    }
    const parts = message.parts.flatMap((part: unknown) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [{ type: "text" as const, text: part.text }]
        : [],
    );
    return parts.length > 0
      ? [{ id: message.id, role: message.role, parts }]
      : [];
  });
}

export const registerAgentRoutes: FastifyPluginAsync = async (api) => {
  api.get<{ Querystring: SearchQuery }>(
    "/v1/mail/search",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const accountScope = parseMailboxAccountScope(request.query.account);
      if (!accountScope.valid) {
        await sendProblem(request, reply, 400, "Invalid mailbox account");
        return;
      }
      const accountIds = await resolveMailboxAccountIds({
        userId: session.userId,
        accountId: accountScope.accountId,
      });
      if (!accountIds) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
      if (!query || query.length > 1_000) {
        await sendProblem(request, reply, 400, "A valid mail search query is required");
        return;
      }
      const results = await searchMailForUser({
        userId: session.userId,
        accountId: accountScope.accountId,
        query,
      });
      await sendJson(reply, 200, { results });
    },
  );

  api.post<{ Body: unknown }>(
    "/v1/agent",
    { onRequest: mutationAccessHooks, bodyLimit: 10_000_000 },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      if (!isAiConfigured()) {
        await sendProblem(request, reply, 503, "AI model is not configured");
        return;
      }
      const uiMessages = parseMessages(request.body);
      if (uiMessages.length === 0) {
        await sendProblem(request, reply, 400, "A text agent message is required");
        return;
      }
      const requestedThreadId =
        request.body &&
        typeof request.body === "object" &&
        "currentThreadId" in request.body &&
        typeof request.body.currentThreadId === "string"
          ? request.body.currentThreadId
          : null;
      const requestedAccount =
        request.body &&
        typeof request.body === "object" &&
        "account" in request.body
          ? request.body.account
          : undefined;
      const accountScope = parseMailboxAccountScope(requestedAccount);
      if (!accountScope.valid) {
        await sendProblem(request, reply, 400, "Invalid mailbox account");
        return;
      }
      const accountIds = await resolveMailboxAccountIds({
        userId: session.userId,
        accountId: accountScope.accountId,
      });
      if (!accountIds) {
        await sendProblem(request, reply, 404, "Connected Gmail account not found");
        return;
      }
      const isInScope = (accountId: string): boolean =>
        accountScope.accountId === null || accountId === accountScope.accountId;
      const loadScopedThread = async (threadId: string) => {
        const thread = await getMailboxThreadForAgent(session.userId, threadId);
        return thread && isInScope(thread.accountId) ? thread : null;
      };
      const currentThread = requestedThreadId
        ? await loadScopedThread(requestedThreadId)
        : null;
      const agent = createMailAgent(
        {
          searchMail: (query) =>
            searchMailForUser({
              userId: session.userId,
              accountId: accountScope.accountId,
              query,
            }),
          getThread: async (threadId) => {
            const thread = await loadScopedThread(threadId);
            return thread
              ? {
                  ...thread,
                  messages: thread.messages.map((message) => ({
                    ...message,
                    sentAt: message.sentAt.toISOString(),
                  })),
                }
              : null;
          },
          listAttachments: async (threadId) => {
            const thread = await loadScopedThread(threadId);
            return thread
              ? listMailboxThreadAttachments(session.userId, threadId)
              : [];
          },
          draftReply: async (threadId, instruction) => {
            const thread = await loadScopedThread(threadId);
            if (!thread) throw new Error("The email thread was not found.");
            const draft = await generateDraftForUser({
              userId: session.userId,
              threadId,
              instruction,
            });
            if (!draft) throw new Error("The email thread was not found.");
            return { draftId: draft.id, threadId: draft.threadId, text: draft.currentText };
          },
          queryInvookMailbox: (input) =>
            queryMailboxForUser({
              userId: session.userId,
              accountId: accountScope.accountId,
              ...input,
            }),
        },
        currentThread ? { currentThreadId: currentThread.id } : undefined,
      );
      const controller = new AbortController();
      request.raw.once("aborted", () => controller.abort());
      reply.raw.once("close", () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      reply.hijack();
      await pipeAgentUIStreamToResponse({
        response: reply.raw,
        agent,
        uiMessages,
        abortSignal: controller.signal,
        headers: { "x-request-id": request.id },
      });
    },
  );
};
