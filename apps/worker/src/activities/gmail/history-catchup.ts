export type GmailHistoryCatchupDisposition =
  | "complete"
  | "continue_durably"
  | "superseded";

type GmailReplicaState =
  | "pending"
  | "snapshotting"
  | "replaying"
  | "ready"
  | "repairing"
  | "failed"
  | "deleting";

export type GmailHistoryCatchupPlan =
  | {
      kind: "apply";
      expectedCursor: string;
      startHistoryId: string;
      stateAfterApply: "ready" | "snapshotting" | "repairing";
      ingestionMode: "initial" | "incremental";
      shouldRepairExpiredCursor: boolean;
    }
  | {
      kind: "defer";
      state: Exclude<GmailReplicaState, "ready">;
    };

export function planGmailHistoryCatchup(input: {
  replicaState: GmailReplicaState;
  initialHistoryId: string;
  historyCursor: string | null;
  repairStartingHistoryCursor?: string | null;
}): GmailHistoryCatchupPlan {
  const expectedCursor = input.historyCursor ?? input.initialHistoryId;
  if (input.replicaState === "ready") {
    return {
      kind: "apply",
      expectedCursor,
      startHistoryId: expectedCursor,
      stateAfterApply: "ready",
      ingestionMode: "incremental",
      shouldRepairExpiredCursor: true,
    };
  }
  if (input.replicaState === "snapshotting") {
    return {
      kind: "apply",
      expectedCursor,
      startHistoryId: expectedCursor,
      stateAfterApply: "snapshotting",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    };
  }
  if (input.replicaState === "repairing" && input.repairStartingHistoryCursor) {
    const startHistoryId =
      BigInt(expectedCursor) > BigInt(input.repairStartingHistoryCursor)
        ? expectedCursor
        : input.repairStartingHistoryCursor;
    return {
      kind: "apply",
      expectedCursor,
      startHistoryId,
      stateAfterApply: "repairing",
      ingestionMode: "initial",
      shouldRepairExpiredCursor: false,
    };
  }
  return { kind: "defer", state: input.replicaState };
}

export function gmailHistoryCatchupDisposition(input: {
  applied: boolean;
  pendingHistoryCursor: string | null;
}): GmailHistoryCatchupDisposition {
  if (!input.applied) return "superseded";
  return input.pendingHistoryCursor ? "continue_durably" : "complete";
}
