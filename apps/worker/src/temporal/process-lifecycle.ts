interface WorkerProcessLifecycle {
  logFatal: (message: string, details: { name: string }) => void;
  exit: (code: number) => void;
}

const processLifecycle: WorkerProcessLifecycle = {
  logFatal: (message, details) => console.error(message, details),
  exit: (code) => process.exit(code),
};

export function terminateWorkerAfterFatalError(
  error: unknown,
  lifecycle: WorkerProcessLifecycle = processLifecycle,
): void {
  lifecycle.logFatal("worker: fatal", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  lifecycle.exit(1);
}
