import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { getDatabase, type Database } from "./client";
import { connectedAccounts, threads } from "./schema";
import { enqueueLiveInboxThreadLabelAnalyses } from "./thread-label-analysis";
import {
  automaticThreadLabelCutoff,
  recentInboxThreadCondition,
} from "./thread-label-eligibility";
import { createThreadLabelScanStep, readmitWorkflowStep } from "./workflows";

/**
 * Threads examined per page.
 *
 * Reservation is one transaction per page, so the page bounds both lock
 * duration and how much work a single Activity attempt can lose.
 */
export const THREAD_LABEL_SCAN_PAGE_SIZE = 100;

export interface ThreadLabelScanPage {
  reservedThreadCount: number;
  nextCursorThreadId: string | null;
}

/**
 * Offers every connected account's scan to Temporal.
 *
 * The scan entity coalesces repeat offers, so running this on each boot costs
 * one signal per account rather than a queue of duplicated work.
 */
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
    await readmitWorkflowStep(createThreadLabelScanStep(account), database);
  }
  return accounts.length;
}

/**
 * Reserves one page of threads still owed an automatic label.
 *
 * Reservation and analysis admission share a transaction, so a thread cannot be
 * marked running without the durable work that will label it. The page is read
 * one row wider than it is returned, which is how the caller learns whether a
 * further page exists without a second query.
 */
export async function scanRecentThreadLabelPage(
  input: {
    userId: string;
    accountId: string;
    referenceAt: Date;
    cursorThreadId: string | null;
  },
  database: Database = getDatabase(),
): Promise<ThreadLabelScanPage> {
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
      .limit(THREAD_LABEL_SCAN_PAGE_SIZE + 1);
    const page = candidates.slice(0, THREAD_LABEL_SCAN_PAGE_SIZE);
    const reservedThreadCount = await enqueueLiveInboxThreadLabelAnalyses(
      { ...input, threadIds: page.map((thread) => thread.id) },
      transaction,
    );
    const cursorThreadId = page.at(-1)?.id;
    return {
      reservedThreadCount,
      nextCursorThreadId:
        candidates.length > THREAD_LABEL_SCAN_PAGE_SIZE && cursorThreadId
          ? cursorThreadId
          : null,
    };
  });
}
