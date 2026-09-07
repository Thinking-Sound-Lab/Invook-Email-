/**
 * Repair walks `threads.list` and then deletes local messages whose threads
 * were never discovered. Live catch-up during that walk can ingest a brand-new
 * thread that the walk already passed; those messages must not be treated as
 * "absent from Gmail".
 */
export function shouldDeleteStoredMessageDuringRepair(input: {
  isOnDiscoveredThread: boolean;
  providerHistoryId: string | null;
  repairStartingHistoryCursor: string;
}): boolean {
  if (input.isOnDiscoveredThread) return false;
  if (!input.providerHistoryId) return true;
  return (
    BigInt(input.providerHistoryId) <=
    BigInt(input.repairStartingHistoryCursor)
  );
}
