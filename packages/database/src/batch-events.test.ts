import assert from "node:assert/strict";
import { test } from "node:test";

import { createBatchEventIdempotencyKey } from "./batch-events";

test("duplicate webhook delivery uses one durable correlation key", () => {
  const first = createBatchEventIdempotencyKey({
    provider: "openai",
    webhookId: "webhook-123",
  });
  const duplicate = createBatchEventIdempotencyKey({
    provider: "openai",
    webhookId: "webhook-123",
  });
  const distinct = createBatchEventIdempotencyKey({
    provider: "openai",
    webhookId: "webhook-456",
  });

  assert.equal(duplicate, first);
  assert.notEqual(distinct, first);
});
