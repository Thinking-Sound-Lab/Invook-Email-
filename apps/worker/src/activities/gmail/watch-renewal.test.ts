import assert from "node:assert/strict";
import { test } from "node:test";

import { runDailyGmailWatchRenewal } from "./watch-renewal";

test("daily watch renewal durably schedules one successor before catch-up", async () => {
  const calls: string[] = [];
  const result = await runDailyGmailWatchRenewal({
    renew: async () => {
      calls.push("renew");
      return {
        renewedAt: new Date("2026-08-13T10:00:00.000Z"),
        expirationAt: new Date("2026-08-20T10:00:00.000Z"),
      };
    },
    catchUp: async () => {
      calls.push("catch-up");
      return { status: "complete", historyCursor: "123" };
    },
    scheduleNext: async () => {
      calls.push("schedule-next");
      return "next-renewal-step";
    },
  });

  assert.deepEqual(calls, ["renew", "schedule-next", "catch-up"]);
  assert.equal(result.nextRenewalStepId, "next-renewal-step");
  assert.equal(result.catchup.status, "complete");
});

test("failed catch-up retains the already-scheduled daily successor", async () => {
  let scheduleCalls = 0;
  await assert.rejects(
    runDailyGmailWatchRenewal({
      renew: async () => ({
        renewedAt: new Date("2026-08-13T10:00:00.000Z"),
        expirationAt: new Date("2026-08-20T10:00:00.000Z"),
      }),
      catchUp: async () => {
        throw new Error("catch-up failed");
      },
      scheduleNext: async () => {
        scheduleCalls += 1;
        return "next-renewal-step";
      },
    }),
    /catch-up failed/,
  );
  assert.equal(scheduleCalls, 1);
});

test("failed successor scheduling does not start catch-up", async () => {
  let catchupCalls = 0;
  await assert.rejects(
    runDailyGmailWatchRenewal({
      renew: async () => ({
        renewedAt: new Date("2026-08-13T10:00:00.000Z"),
        expirationAt: new Date("2026-08-20T10:00:00.000Z"),
      }),
      catchUp: async () => {
        catchupCalls += 1;
        return { status: "complete" };
      },
      scheduleNext: async () => {
        throw new Error("scheduling failed");
      },
    }),
    /scheduling failed/,
  );
  assert.equal(catchupCalls, 0);
});
