import { and, eq, ne, sql } from "drizzle-orm";

import {
  getDatabase,
  type DatabaseExecutor,
  type DatabaseTransaction,
} from "./client";
import { connectedAccounts } from "./schema";

// Every lifecycle operation takes this lock before account/replica row locks.
// Use the supplied transaction for all database work: waiters must never hold
// the query pool while the lock holder needs another query connection.
export async function withGmailIdentityLock<T>(
  providerAccountId: string,
  operation: (transaction: DatabaseTransaction) => Promise<T>,
  database: DatabaseExecutor = getDatabase(),
): Promise<T> {
  return database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(
      hashtextextended(${`invook:gmail-identity:${providerAccountId}`}, 0)
    )`);
    return operation(transaction);
  });
}

export class GmailConnectionDeletingError extends Error {
  constructor() {
    super("The Gmail connection is still disconnecting.");
    this.name = "GmailConnectionDeletingError";
  }
}

export async function getGmailIdentityConnection(
  accountId: string,
  database: DatabaseExecutor = getDatabase(),
): Promise<typeof connectedAccounts.$inferSelect | null> {
  const [account] = await database
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.id, accountId),
        eq(connectedAccounts.provider, "gmail"),
      ),
    )
    .limit(1);
  return account ?? null;
}

// reconnect_required connections still own a replica and need notifications
// once authorization is restored. Never stop their mailbox watch either.
export async function hasOtherGmailConnections(
  input: { accountId: string; providerAccountId: string },
  database: DatabaseExecutor = getDatabase(),
): Promise<boolean> {
  const [account] = await database
    .select({ id: connectedAccounts.id })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.provider, "gmail"),
        eq(connectedAccounts.providerAccountId, input.providerAccountId),
        ne(connectedAccounts.id, input.accountId),
        ne(connectedAccounts.status, "disconnected"),
      ),
    )
    .limit(1);
  return Boolean(account);
}
