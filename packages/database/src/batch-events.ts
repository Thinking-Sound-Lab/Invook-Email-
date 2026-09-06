export function createBatchEventIdempotencyKey(input: {
  webhookId: string;
}): string {
  return `openai.batch-event:${input.webhookId}`;
}
