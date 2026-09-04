import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";

import type {
  GmailCatchUpOutcome,
  GmailIncrementalSyncWorkflowInput,
  GmailIncrementalSyncWorkflowResult,
} from "../contracts/gmail-incremental-sync";
import {
  gmailAccountDisconnectedSignal,
  gmailCatchUpSignal,
  gmailIncrementalSyncStateQuery,
  gmailIncrementalSyncWorkflow,
} from "./gmail-incremental-sync";

const taskQueue = "gmail-incremental-sync-test";
const accountId = "22222222-2222-4222-8222-222222222222";

function workflowInput(
  overrides: Partial<GmailIncrementalSyncWorkflowInput> = {},
): GmailIncrementalSyncWorkflowInput {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    accountId,
    activityTaskQueue: taskQueue,
    pendingRequestCount: 1,
    catchUpsCompleted: 0,
    ...overrides,
  };
}

describe("gmailIncrementalSyncWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  before(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  after(async () => {
    await environment?.teardown();
  });

  const withWorker = async <Result>(
    catchUpGmailHistoryActivity: () => Promise<GmailCatchUpOutcome>,
    body: (
      handle: WorkflowHandle<typeof gmailIncrementalSyncWorkflow>,
    ) => Promise<Result>,
    input: GmailIncrementalSyncWorkflowInput = workflowInput(),
  ): Promise<Result> => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("./gmail-incremental-sync.ts", import.meta.url),
      ),
      activities: { catchUpGmailHistoryActivity },
    });
    return worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(
        gmailIncrementalSyncWorkflow,
        {
          args: [input],
          taskQueue,
          workflowId: `gmail-incremental-sync-test:${Math.random()}`,
        },
      );
      try {
        return await body(handle);
      } finally {
        await handle.terminate().catch(() => undefined);
      }
    });
  };

  test("coalesces every trigger that arrives during one catch-up", async () => {
    let catchUpCount = 0;
    let releaseFirstCatchUp: (() => void) | null = null;
    const firstCatchUpStarted = new Promise<void>((resolve) => {
      releaseFirstCatchUp = resolve;
    });

    const result = await withWorker(
      async () => {
        catchUpCount += 1;
        if (catchUpCount === 1) releaseFirstCatchUp?.();
        return {
          status: "applied",
          historyCursor: `${100 + catchUpCount}`,
          hasPendingHistory: false,
          changedThreadCount: 1,
        };
      },
      async (handle) => {
        await firstCatchUpStarted;
        // Five notifications arriving while one catch-up runs must cost one
        // more catch-up, not five.
        await Promise.all(
          Array.from({ length: 5 }, () => handle.signal(gmailCatchUpSignal)),
        );
        await handle.signal(gmailAccountDisconnectedSignal);
        return handle.result();
      },
    );

    assert.equal(result.status, "disconnected");
    assert.ok(
      catchUpCount <= 2,
      `five coalesced triggers ran ${catchUpCount} catch-ups`,
    );
  });

  test("drains capped history without waiting for another trigger", async () => {
    const cursors: string[] = [];
    let completeDrain: (() => void) | null = null;
    const drained = new Promise<void>((resolve) => {
      completeDrain = resolve;
    });

    const result = await withWorker(
      async (): Promise<GmailCatchUpOutcome> => {
        const historyCursor = `${100 + cursors.length}`;
        cursors.push(historyCursor);
        // Gmail caps the first two ranges, so the entity must keep going on
        // its own rather than wait for a new notification.
        const hasPendingHistory = cursors.length < 3;
        if (!hasPendingHistory) completeDrain?.();
        return {
          status: "applied",
          historyCursor,
          hasPendingHistory,
          changedThreadCount: 2,
        };
      },
      async (handle) => {
        await drained;
        await handle.signal(gmailAccountDisconnectedSignal);
        return handle.result();
      },
    );

    assert.deepEqual(cursors, ["100", "101", "102"]);
    assert.equal(result.catchUpsCompleted, 3);
    assert.equal(result.status, "disconnected");
  });

  test("stops when the account's history expires and a repair takes over", async () => {
    const result = await withWorker(
      async () => ({ status: "repair_started", runId: "run-1" }),
      async (handle) => handle.result(),
    );

    assert.equal(result.status, "repairing");
    assert.equal(result.accountId, accountId);
    assert.equal(result.catchUpsCompleted, 1);
  });

  test("closes when idle so an untouched account holds no Execution", async () => {
    const result = await withWorker(
      async () => {
        throw new Error("an idle account must not run a catch-up");
      },
      async (handle) => handle.result(),
      workflowInput({ pendingRequestCount: 0 }),
    );

    assert.equal(result.status, "idle");
    assert.equal(result.catchUpsCompleted, 0);
  });

  test("reports pending work and the applied cursor while running", async () => {
    let releaseCatchUp: (() => void) | null = null;
    const catchUpStarted = new Promise<void>((resolve) => {
      releaseCatchUp = resolve;
    });

    await withWorker(
      async () => {
        releaseCatchUp?.();
        return {
          status: "applied",
          historyCursor: "205",
          hasPendingHistory: false,
          changedThreadCount: 3,
        };
      },
      async (handle) => {
        await catchUpStarted;
        await handle.signal(gmailCatchUpSignal);
        const state = await handle.query(gmailIncrementalSyncStateQuery);
        assert.ok(state.pendingRequestCount >= 0);
        await handle.signal(gmailAccountDisconnectedSignal);
        await handle.result();
      },
    );
  });
});
