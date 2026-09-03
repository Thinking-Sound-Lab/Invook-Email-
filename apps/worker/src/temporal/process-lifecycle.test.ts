import assert from "node:assert/strict";
import { test } from "node:test";

import { terminateWorkerAfterFatalError } from "./process-lifecycle";

test("a fatal worker error exits so the container runtime can restart it", () => {
  let exitCode: number | null = null;
  let fatalLog: { message: string; name: string } | null = null;

  terminateWorkerAfterFatalError(new TypeError("connection lost"), {
    logFatal: (message, details) => {
      fatalLog = { message, name: details.name };
    },
    exit: (code) => {
      exitCode = code;
    },
  });

  assert.deepEqual(fatalLog, {
    message: "worker: fatal",
    name: "TypeError",
  });
  assert.equal(exitCode, 1);
});
