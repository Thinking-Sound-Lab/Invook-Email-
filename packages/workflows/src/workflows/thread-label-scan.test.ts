import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type {
  ThreadLabelScanPageInput,
  ThreadLabelScanPageOutcome,
  ThreadLabelScanWorkflowInput,
  ThreadLabelScanWorkflowResult,
} from "../contracts/thread-label-scan";
import { threadLabelScanPagesPerExecution } from "../contracts/thread-label-scan";
import {
  threadLabelRescanSignal,
  threadLabelScanWorkflow,
} from "./thread-label-scan";

const taskQueue = "thread-label-scan-test";
const accountId = "22222222-2222-4222-8222-222222222222";

function workflowInput(
  overrides: Partial<ThreadLabelScanWorkflowInput> = {},
): ThreadLabelScanWorkflowInput {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    accountId,
    activityTaskQueue: taskQueue,
    referenceAt: null,
    cursorThreadId: null,
    pagesCompleted: 0,
    reservedThreadCount: 0,
    isRescanRequested: false,
    ...overrides,
  };
}

describe("threadLabelScanWorkflow", () => {
  let environment: TestWorkflowEnvironment;

  before(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  });

  after(async () => {
    await environment?.teardown();
  });

  const withWorker = async <Result>(
    scanThreadLabelPageActivity: (
      input: ThreadLabelScanPageInput,
    ) => Promise<ThreadLabelScanPageOutcome>,
    body: (
      handle: WorkflowHandle<typeof threadLabelScanWorkflow>,
    ) => Promise<Result>,
    input: ThreadLabelScanWorkflowInput = workflowInput(),
  ): Promise<Result> => {
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(
        new URL("./thread-label-scan.ts", import.meta.url),
      ),
      activities: { scanThreadLabelPageActivity },
    });
    return worker.runUntil(async () => {
      const handle = await environment.client.workflow.start(
        threadLabelScanWorkflow,
        {
          args: [input],
          taskQueue,
          workflowId: `thread-label-scan-test:${Math.random()}`,
        },
      );
      try {
        return await body(handle);
      } finally {
        await handle.terminate().catch(() => undefined);
      }
    });
  };

  test("walks to the end of the account holding one frozen reference time", async () => {
    const referenceTimes = new Set<string>();
    const cursors: Array<string | null> = [];

    const result: ThreadLabelScanWorkflowResult = await withWorker(
      async (input) => {
        referenceTimes.add(input.referenceAt);
        cursors.push(input.cursorThreadId);
        const nextCursorThreadId =
          cursors.length < 3 ? `cursor-${cursors.length}` : null;
        return { reservedThreadCount: 10, nextCursorThreadId };
      },
      async (handle) => handle.result(),
    );

    assert.deepEqual(cursors, [null, "cursor-1", "cursor-2"]);
    // Eligibility must not drift mid-walk.
    assert.equal(referenceTimes.size, 1);
    assert.deepEqual(result, {
      accountId,
      pagesCompleted: 3,
      reservedThreadCount: 30,
      passesCompleted: 1,
    });
  });

  test("a rescan restarts from the first thread with a fresh reference time", async () => {
    const passes: Array<{ referenceAt: string; cursorThreadId: string | null }> =
      [];
    let signalRescan: (() => void) | null = null;
    const firstPageDone = new Promise<void>((resolve) => {
      signalRescan = resolve;
    });

    const result = await withWorker(
      async (input) => {
        passes.push({
          referenceAt: input.referenceAt,
          cursorThreadId: input.cursorThreadId,
        });
        if (passes.length === 1) signalRescan?.();
        return { reservedThreadCount: 1, nextCursorThreadId: null };
      },
      async (handle) => {
        await firstPageDone;
        await handle.signal(threadLabelRescanSignal);
        return handle.result();
      },
    );

    assert.equal(result.passesCompleted, 2);
    assert.equal(result.pagesCompleted, 2);
    // The second pass restarts at the first thread, because a thread that
    // arrived during the walk can sort before the cursor.
    assert.deepEqual(
      passes.map((pass) => pass.cursorThreadId),
      [null, null],
    );
    assert.notEqual(passes[0]?.referenceAt, passes[1]?.referenceAt);
  });

  test("many rescan signals during one walk cost exactly one extra pass", async () => {
    let pageCount = 0;
    let signalRescans: (() => void) | null = null;
    const walkStarted = new Promise<void>((resolve) => {
      signalRescans = resolve;
    });

    const result = await withWorker(
      async () => {
        pageCount += 1;
        if (pageCount === 1) signalRescans?.();
        return { reservedThreadCount: 0, nextCursorThreadId: null };
      },
      async (handle) => {
        await walkStarted;
        await Promise.all(
          Array.from({ length: 6 }, () =>
            handle.signal(threadLabelRescanSignal),
          ),
        );
        return handle.result();
      },
    );

    assert.ok(
      result.passesCompleted <= 2,
      `six coalesced rescans ran ${result.passesCompleted} passes`,
    );
  });

  test("continues as new past the page budget without losing the cursor", async () => {
    const observedCursors: Array<string | null> = [];
    const totalPageCount = threadLabelScanPagesPerExecution + 4;

    const result = await withWorker(
      async (input) => {
        observedCursors.push(input.cursorThreadId);
        const pageNumber = observedCursors.length;
        return {
          reservedThreadCount: 1,
          nextCursorThreadId:
            pageNumber < totalPageCount ? `cursor-${pageNumber}` : null,
        };
      },
      async (handle) => handle.result(),
    );

    assert.equal(observedCursors.length, totalPageCount);
    // The cursor survives the Continue-As-New boundary unbroken.
    assert.equal(
      observedCursors[threadLabelScanPagesPerExecution],
      `cursor-${threadLabelScanPagesPerExecution}`,
    );
    assert.equal(result.pagesCompleted, totalPageCount);
    assert.equal(result.reservedThreadCount, totalPageCount);
  });
});
