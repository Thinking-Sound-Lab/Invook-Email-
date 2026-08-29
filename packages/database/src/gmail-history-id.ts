export function isOlderGmailHistoryId(
  incomingHistoryId: string | null | undefined,
  storedHistoryId: string | null | undefined,
): boolean {
  if (!incomingHistoryId || !storedHistoryId) return false;
  return BigInt(incomingHistoryId) < BigInt(storedHistoryId);
}
