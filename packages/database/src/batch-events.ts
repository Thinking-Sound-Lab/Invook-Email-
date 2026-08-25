export function createBatchEventIdempotencyKey(input: {
  provider: "openai" | "azure-openai";
  webhookId: string;
}): string {
  return `${input.provider}.batch-event:${input.webhookId}`;
}
