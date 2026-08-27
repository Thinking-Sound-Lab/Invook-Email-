import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { isAiConfigured } from "@invook/ai";
import { memoryTypes, type MemoryType } from "@invook/contracts";
import {
  createUserMemory,
  deleteUserMemory,
  getMemoriesForUser,
  MemoryConflictError,
  updateUserMemory,
} from "@invook/database";

import { mutationAccessHooks, requireSession, requireUuidParameter } from "../access";
import {
  type MailboxAccountQuery,
  parseRequiredMailboxAccountId,
} from "../mailbox-account-scope";
import { sendJson, sendProblem } from "../responses";
import { serializeMemoryEntry } from "../serializers";

type MemoryParams = {
  memoryId: string;
};

type MemoryPayload = {
  type: MemoryType;
  contactEmail: string | null;
  statement: string;
};

function parseMemoryPayload(body: unknown): MemoryPayload | null {
  if (!body || typeof body !== "object") return null;
  const type = "type" in body ? body.type : undefined;
  const statement = "statement" in body ? body.statement : undefined;
  const contactEmail = "contactEmail" in body ? body.contactEmail : null;
  if (
    typeof type !== "string" ||
    !memoryTypes.includes(type as MemoryType) ||
    typeof statement !== "string"
  ) {
    return null;
  }

  const normalizedStatement = statement.trim().replace(/\s+/g, " ");
  if (normalizedStatement.length < 3 || normalizedStatement.length > 500) {
    return null;
  }
  if (type === "contact") {
    if (typeof contactEmail !== "string") return null;
    const normalizedEmail = contactEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return null;
    return {
      type: type as MemoryType,
      contactEmail: normalizedEmail,
      statement: normalizedStatement,
    };
  }
  return {
    type: type as MemoryType,
    contactEmail: null,
    statement: normalizedStatement,
  };
}

async function requirePayload(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<MemoryPayload | null> {
  const payload = parseMemoryPayload(request.body);
  if (!payload) {
    await sendProblem(
      request,
      reply,
      400,
      "Memory type and statement must be valid",
    );
    return null;
  }
  return payload;
}

export const registerMemoryRoutes: FastifyPluginAsync = async (api) => {
  api.get<{ Querystring: MailboxAccountQuery }>(
    "/",
    { onRequest: requireSession },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const accountId = parseRequiredMailboxAccountId(request.query.account);
      if (!accountId) {
        await sendProblem(request, reply, 400, "A valid mailbox account is required");
        return;
      }
      const result = await getMemoriesForUser({
        userId: session.userId,
        accountId,
      });
      if (!result) {
        await sendProblem(
          request,
          reply,
          404,
          "Connected Gmail account not found",
        );
        return;
      }
      await sendJson(reply, 200, {
        aiConfigured: isAiConfigured(),
        syncState: result.account.syncState.memory,
        memories: result.entries.map((entry) =>
          serializeMemoryEntry({ ...entry, memoryType: entry.type }),
        ),
      });
    },
  );

  api.post<{ Body: unknown }>(
    "/",
    { onRequest: mutationAccessHooks },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const payload = await requirePayload(request, reply);
      if (!payload) return;
      const accountId =
        request.body && typeof request.body === "object" && "accountId" in request.body
          ? parseRequiredMailboxAccountId(request.body.accountId)
          : null;
      if (!accountId) {
        await sendProblem(request, reply, 400, "A valid mailbox account is required");
        return;
      }
      const memory = await createUserMemory({
        userId: session.userId,
        accountId,
        ...payload,
      });
      if (!memory) {
        await sendProblem(
          request,
          reply,
          404,
          "Connected Gmail account not found",
        );
        return;
      }
      await sendJson(reply, 201, { memory: serializeMemoryEntry(memory) });
    },
  );

  api.patch<{ Params: MemoryParams; Body: unknown }>(
    "/:memoryId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("memoryId", "Memory ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const payload = await requirePayload(request, reply);
      if (!payload) return;

      try {
        const memory = await updateUserMemory({
          userId: session.userId,
          memoryId: request.params.memoryId,
          ...payload,
        });
        if (!memory) {
          await sendProblem(request, reply, 404, "Memory not found");
          return;
        }
        await sendJson(reply, 200, { memory: serializeMemoryEntry(memory) });
      } catch (error) {
        if (error instanceof MemoryConflictError) {
          await sendProblem(request, reply, 409, error.message);
          return;
        }
        throw error;
      }
    },
  );

  api.delete<{ Params: MemoryParams }>(
    "/:memoryId",
    {
      onRequest: [
        ...mutationAccessHooks,
        requireUuidParameter("memoryId", "Memory ID must be valid"),
      ],
    },
    async (request, reply) => {
      const session = request.invookSession;
      if (!session) return;
      const deleted = await deleteUserMemory({
        userId: session.userId,
        memoryId: request.params.memoryId,
      });
      if (!deleted) {
        await sendProblem(request, reply, 404, "Memory not found");
        return;
      }
      await sendJson(reply, 200, { deleted: true });
    },
  );
};
