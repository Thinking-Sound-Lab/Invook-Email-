import type { FastifyPluginAsync } from "fastify";

import { resolveMailboxAccountIds } from "@invook/database";

import { requireSession } from "../access";
import {
  type MailboxAccountQuery,
  parseMailboxAccountScope,
} from "../mailbox-account-scope";
import { sendJson, sendProblem } from "../responses";
import { searchMailForUser } from "../services/search";

type SearchQuery = MailboxAccountQuery & { q?: unknown };

export const registerMailSearchRoutes: FastifyPluginAsync = async (api) => {
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
};
