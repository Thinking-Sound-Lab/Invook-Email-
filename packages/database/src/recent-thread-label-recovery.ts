import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import { connectedAccounts, threads } from "./schema";
import { enqueueLiveInboxThreadLabelAnalyses } from "./thread-label-analysis";
import {
  automaticThreadLabelCutoff,
  recentInboxThreadCondition,
} from "./thread-label-eligibility";
import { enqueueWorkflowStepWithExecutor } from "./workflows";

export async function enqueueRecentThreadLabelRecoveries(
  database: Database = getDatabase(),
): Promise<number> {
  const accounts = await database
    .select({
      userId: connectedAccounts.userId,
      accountId: connectedAccounts.id,
    })
    .from(connectedAccounts)
    .where(eq(connectedAccounts.status, "connected"));
  for (const account of accounts) {
    await database.transaction((transaction) =>
      enqueueWorkflowStepWithExecutor(
        {
          ...account,
          stepType: "label.recent.scan",
          payload: {
            referenceAt: new Date().toISOString(),
            cursorThreadId: null,
          },
          idempotencyKey: `label.recent.scan:recent-only-v1:${account.accountId}`,
        },
        transaction,
      ),
    );
  }
  return accounts.length;
}

export async function scanRecentThreadLabelPage(
  input: {
    userId: string;
    accountId: string;
    referenceAt: Date;
    cursorThreadId: string | null;
  },
  database: Database = getDatabase(),
): Promise<{ enqueuedCount: number; continuationStepId: string | null }> {
  return database.transaction(async (transaction) => {
    const candidates = await transaction
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.userId, input.userId),
          eq(threads.accountId, input.accountId),
          inArray(threads.labelAnalysisState, ["pending", "not_requested"]),
          input.cursorThreadId
            ? gt(threads.id, input.cursorThreadId)
            : undefined,
          recentInboxThreadCondition(
            automaticThreadLabelCutoff(input.referenceAt),
          ),
        ),
      )
      .orderBy(asc(threads.id))
      .limit(101);
    const page = candidates.slice(0, 100);
    const enqueuedCount = await enqueueLiveInboxThreadLabelAnalyses(
      { ...input, threadIds: page.map((thread) => thread.id) },
      transaction,
    );
    const cursorThreadId = page.at(-1)?.id;
    const continuationStepId =
      candidates.length > 100 && cursorThreadId
        ? await enqueueWorkflowStepWithExecutor(
            {
              userId: input.userId,
              accountId: input.accountId,
              stepType: "label.recent.scan",
              payload: {
                referenceAt: input.referenceAt.toISOString(),
                cursorThreadId,
              },
              idempotencyKey: `label.recent.scan:recent-only-v1:${input.accountId}:${cursorThreadId}`,
            },
            transaction,
          )
        : null;
    return { enqueuedCount, continuationStepId };
  });
}
