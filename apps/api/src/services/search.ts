import { searchMailbox } from "@invook/database";

export async function searchMailForUser(input: {
  userId: string;
  query: string;
  limit?: number;
}) {
  const results = await searchMailbox({
    userId: input.userId,
    query: input.query,
    limit: input.limit,
  });
  return results.map((result) => ({
    ...result,
    sentAt: result.sentAt.toISOString(),
  }));
}
