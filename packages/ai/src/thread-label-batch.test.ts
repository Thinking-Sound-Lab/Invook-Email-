import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyThreadLabelBatchFailure,
  getThreadLabelBatchModelId,
  prepareThreadLabelBatch,
  THREAD_LABEL_BATCH_REQUEST_LIMIT,
  ThreadLabelBatchConfigurationError,
  type ThreadLabelBatchEntry,
} from "./thread-label-batch";

test("thread-label Batch defaults to GPT-5.6 Luna", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
  const previousModel = process.env.OPENAI_LABEL_BATCH_MODEL;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_WEBHOOK_SECRET = "test-secret";
  delete process.env.OPENAI_LABEL_BATCH_MODEL;
  try {
    assert.equal(getThreadLabelBatchModelId(), "gpt-5.6-luna");
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousWebhookSecret === undefined) {
      delete process.env.OPENAI_WEBHOOK_SECRET;
    } else {
      process.env.OPENAI_WEBHOOK_SECRET = previousWebhookSecret;
    }
    if (previousModel === undefined) delete process.env.OPENAI_LABEL_BATCH_MODEL;
    else process.env.OPENAI_LABEL_BATCH_MODEL = previousModel;
  }
});

function entry(index: number): ThreadLabelBatchEntry {
  return {
    threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    contentVersion: 1,
    assignmentVersion: null,
    fallbackLabelId: "others-label",
    thread: {
      subject: `Thread ${index}`,
      messages: [{
        subject: `Thread ${index}`,
        sender: "Sender <sender@example.test>",
        recipients: ["owner@example.test"],
        bodyText: "Stored Inbox content.",
        sentAt: "2026-08-20T00:00:00.000Z",
      }],
    },
    definitions: [{
      id: "important-label",
      name: "Important",
      description: "Requires timely attention.",
      definitionVersion: 1,
    }],
  };
}

test("thread-label Batch preparation is bounded to 2,000 durable manifest entries", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
  const previousModel = process.env.OPENAI_LABEL_BATCH_MODEL;
  const previousInputTokenLimit =
    process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_WEBHOOK_SECRET = "test-secret";
  process.env.OPENAI_LABEL_BATCH_MODEL = "test-label-model";
  process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT = "10000000";
  try {
    const prepared = prepareThreadLabelBatch({
      entries: Array.from(
        { length: THREAD_LABEL_BATCH_REQUEST_LIMIT + 1 },
        (_, index) => entry(index + 1),
      ),
    });

    assert.equal(prepared.manifest.length, THREAD_LABEL_BATCH_REQUEST_LIMIT);
    assert.equal(
      prepared.manifest.some(({ threadId }) => threadId === entry(2_001).threadId),
      false,
    );
    const lines = prepared.jsonl.trim().split("\n");
    assert.equal(lines.length, THREAD_LABEL_BATCH_REQUEST_LIMIT);
    const first = JSON.parse(lines[0]!) as {
      custom_id: string;
      url: string;
      body: { model: string; store: boolean };
    };
    assert.equal(first.custom_id, entry(1).threadId);
    assert.equal(first.url, "/v1/responses");
    assert.deepEqual(first.body, {
      ...(first.body as object),
      model: "test-label-model",
      store: false,
    });
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousWebhookSecret === undefined) {
      delete process.env.OPENAI_WEBHOOK_SECRET;
    } else {
      process.env.OPENAI_WEBHOOK_SECRET = previousWebhookSecret;
    }
    if (previousModel === undefined) delete process.env.OPENAI_LABEL_BATCH_MODEL;
    else process.env.OPENAI_LABEL_BATCH_MODEL = previousModel;
    if (previousInputTokenLimit === undefined) {
      delete process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT;
    } else {
      process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT = previousInputTokenLimit;
    }
  }
});

test("thread-label Batch preparation stops before its configured input-token limit", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
  const previousInputTokenLimit =
    process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_WEBHOOK_SECRET = "test-secret";
  process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT = "1500";
  try {
    const prepared = prepareThreadLabelBatch({
      entries: Array.from({ length: 20 }, (_, index) => entry(index + 1)),
    });

    assert.ok(prepared.manifest.length > 0);
    assert.ok(prepared.manifest.length < 20);
    assert.ok(prepared.inputTokenCount <= 1_500);
    assert.equal(prepared.jsonl.trim().split("\n").length, prepared.manifest.length);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
    if (previousWebhookSecret === undefined) {
      delete process.env.OPENAI_WEBHOOK_SECRET;
    } else {
      process.env.OPENAI_WEBHOOK_SECRET = previousWebhookSecret;
    }
    if (previousInputTokenLimit === undefined) {
      delete process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT;
    } else {
      process.env.OPENAI_LABEL_BATCH_INPUT_TOKEN_LIMIT = previousInputTokenLimit;
    }
  }
});

test("thread-label Batch provider failures distinguish retryable failures", () => {
  assert.deepEqual(
    classifyThreadLabelBatchFailure({
      providerState: "failed",
      providerErrors: [
        {
          code: "invalid_request",
          param: null,
          message: "Enqueued token limit reached for this model.",
        },
      ],
    }),
    {
      errorCode: "openai_batch_capacity_exhausted",
      isRetryable: true,
    },
  );
  assert.deepEqual(
    classifyThreadLabelBatchFailure({
      providerState: "failed",
      providerErrors: [
        {
          code: "invalid_request",
          param: "file_id",
          message: "The Batch service cannot access the input file.",
        },
      ],
    }),
    {
      errorCode: "openai_batch_input_file_unavailable",
      isRetryable: true,
    },
  );
  assert.deepEqual(
    classifyThreadLabelBatchFailure({
      providerState: "expired",
      providerErrors: [],
    }),
    { errorCode: "openai_batch_expired", isRetryable: true },
  );
  assert.deepEqual(
    classifyThreadLabelBatchFailure({
      providerState: "failed",
      providerErrors: [
        {
          code: "invalid_request",
          param: "body",
          message: "Invalid request schema.",
        },
      ],
    }),
    { errorCode: "openai_batch_failed", isRetryable: false },
  );
});

test("thread-label Batch preparation requires signed OpenAI configuration", () => {
  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_WEBHOOK_SECRET;
  try {
    assert.throws(
      () => prepareThreadLabelBatch({ entries: [entry(1)] }),
      ThreadLabelBatchConfigurationError,
    );
  } finally {
    if (previousApiKey !== undefined) process.env.OPENAI_API_KEY = previousApiKey;
    if (previousWebhookSecret !== undefined) {
      process.env.OPENAI_WEBHOOK_SECRET = previousWebhookSecret;
    }
  }
});
