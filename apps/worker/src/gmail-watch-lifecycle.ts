import {
  completeWorkflowStep,
  decryptGoogleCredential,
  getDatabase,
  getGmailIdentityConnection,
  getWorkerAccount,
  hasOtherGmailConnections,
  listGmailObjectKeysForAccount,
  markGmailAccountCleanupRunning,
  saveGmailWatchState,
  withGmailIdentityLock,
  type DatabaseExecutor,
} from "@invook/database";
import { GmailApiError, startGmailWatch, stopGmailWatch } from "@invook/gmail";

export class GmailConnectionInactiveError extends Error {
  constructor() {
    super("The Gmail connection is inactive.");
    this.name = "GmailConnectionInactiveError";
  }
}

export async function renewGmailConnectionWatch(
  input: { accountId: string; accessToken: string; topicName: string },
  dependencies: {
    database?: DatabaseExecutor;
    startWatch?: typeof startGmailWatch;
  } = {},
): Promise<{ historyId: string; expirationAt: Date; renewedAt: Date }> {
  const database = dependencies.database ?? getDatabase();
  const identity = await getGmailIdentityConnection(input.accountId, database);
  if (!identity) throw new GmailConnectionInactiveError();
  return withGmailIdentityLock(
    identity.providerAccountId,
    async (transaction) => {
      const account = await getGmailIdentityConnection(
        input.accountId,
        transaction,
      );
      if (account?.status !== "connected")
        throw new GmailConnectionInactiveError();
      const watch = await (dependencies.startWatch ?? startGmailWatch)(
        input.accessToken,
        {
          topicName: input.topicName,
        },
      );
      const expirationAt = new Date(Number(watch.expiration));
      if (!Number.isFinite(expirationAt.getTime())) {
        throw new Error("Gmail returned an invalid watch expiration.");
      }
      const renewedAt = new Date();
      await saveGmailWatchState(
        {
          accountId: account.id,
          watch: {
            topicName: input.topicName,
            historyId: watch.historyId,
            expirationAt,
          },
          renewedAt,
        },
        transaction,
      );
      return { historyId: watch.historyId, expirationAt, renewedAt };
    },
    database,
  );
}

export async function runGmailConnectionCleanup(
  input: {
    accountId: string;
    userId: string;
    cleanupId: string;
    stepId: string;
  },
  dependencies: {
    encryptionKey: string;
    deleteObjects: (keys: string[]) => Promise<void>;
    getStopAccessToken?: (
      accountId: string,
      database: DatabaseExecutor,
    ) => Promise<string>;
    database?: DatabaseExecutor;
    stopWatch?: typeof stopGmailWatch;
  },
): Promise<{ objectCount: number } | { status: "inactive" }> {
  const database = dependencies.database ?? getDatabase();
  const identity = await getGmailIdentityConnection(input.accountId, database);
  if (!identity) return { status: "inactive" };
  return withGmailIdentityLock(
    identity.providerAccountId,
    async (transaction) => {
      const current = await getGmailIdentityConnection(
        input.accountId,
        transaction,
      );
      if (
        current?.userId !== input.userId ||
        current.status !== "disconnected"
      ) {
        return { status: "inactive" };
      }
      await markGmailAccountCleanupRunning(input.cleanupId, transaction);
      const hasOtherConnections = await hasOtherGmailConnections(
        {
          accountId: input.accountId,
          providerAccountId: identity.providerAccountId,
        },
        transaction,
      );
      if (!hasOtherConnections) {
        const account = await getWorkerAccount(input.accountId, transaction);
        if (account) {
          const accessToken = dependencies.getStopAccessToken
            ? await dependencies.getStopAccessToken(
                input.accountId,
                transaction,
              )
            : decryptGoogleCredential(
                account.tokenCiphertext,
                dependencies.encryptionKey,
              ).accessToken;
          try {
            await (dependencies.stopWatch ?? stopGmailWatch)(accessToken);
          } catch (error) {
            if (
              !(error instanceof GmailApiError) ||
              ![400, 401, 403, 404].includes(error.status)
            ) {
              throw error;
            }
          }
        }
      }
      const objectKeys = await listGmailObjectKeysForAccount(
        input.accountId,
        transaction,
      );
      await dependencies.deleteObjects(objectKeys);
      const result = { objectCount: objectKeys.length };
      // Completion removes this connection and its cascaded local data. It must
      // commit under the same identity lock as stop, not after reconnect can run.
      await completeWorkflowStep(input.stepId, result, transaction);
      return result;
    },
    database,
  );
}
