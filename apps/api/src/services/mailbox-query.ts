import type { MailboxQueryResult } from "@invook/contracts";
import { queryInvookMailbox } from "@invook/database";

import { searchMailForUser } from "./search";

export async function queryMailboxForUser(input: {
  userId: string;
  accountId?: string | null;
  searchText?: string;
  invookLabelIds?: string[];
  inboxState?: "any" | "inbox" | "not_inbox";
  readState?: "any" | "read" | "unread";
  sender?: string;
  sentAfter?: string;
  sentBefore?: string;
  cursor?: string;
  limit?: number;
}): Promise<MailboxQueryResult> {
  const searchResults = input.searchText
    ? await searchMailForUser({
        userId: input.userId,
        accountId: input.accountId,
        query: input.searchText,
        limit: 50,
      })
    : null;
  const result = await queryInvookMailbox({
    userId: input.userId,
    accountId: input.accountId,
    candidateMessageIds: searchResults?.map((result) => result.messageId),
    invookLabelIds: input.invookLabelIds,
    inboxState: input.inboxState,
    readState: input.readState,
    sender: input.sender,
    sentAfter: input.sentAfter ? new Date(input.sentAfter) : undefined,
    sentBefore: input.sentBefore ? new Date(input.sentBefore) : undefined,
    cursor: input.cursor,
    limit: input.limit,
  });
  if (result.status === "unavailable") {
    return { ...result, messages: [], nextCursor: null };
  }
  return {
    status: "available",
    messages: result.messages.map((message) => ({
      ...message,
      sentAt: message.sentAt.toISOString(),
    })),
    availableInvookLabels: result.availableInvookLabels,
    nextCursor: result.nextCursor,
  };
}
