import assert from "node:assert/strict";
import test from "node:test";

import { MockLanguageModelV4 } from "ai/test";

import {
  createStoredThreadLabelInputHash,
  createStoredThreadLabelClassifier,
  ThreadLabelClassificationContractError,
  type StoredThreadLabelClassifierInput,
} from "./thread-label-classifier";

const baseInput = {
  thread: {
    subject: "August invoice",
    messages: [{
      subject: "August invoice",
      sender: "Billing <billing@example.com>",
      recipients: ["owner@example.com"],
      bodyText: "Invoice 123 is due next week.",
      sentAt: "2026-08-18T09:00:00.000Z",
    }],
  },
  labelDefinitions: [
    {
      id: "important-label",
      name: "Important",
      description: "Requires timely attention.",
      definitionVersion: 1,
    },
    {
      id: "billing-label",
      name: "Billing",
      description: "Invoices and payment records.",
      definitionVersion: 1,
    },
  ],
  fallbackLabelId: "others-label",
} satisfies StoredThreadLabelClassifierInput;

function classifierWithOutput(output: unknown) {
  const model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 10,
          noCache: 10,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
      warnings: [],
    }),
  });
  return {
    model,
    classify: createStoredThreadLabelClassifier(() => ({
      model,
      modelId: "test/thread-label-model",
    })),
  };
}

test("assigns exactly one selected label for a whole stored thread", async () => {
  const { classify, model } = classifierWithOutput({
    selectedLabelId: "billing-label",
    confidence: 96,
  });

  const result = await classify(baseInput);

  assert.deepEqual(result, {
    modelId: "test/thread-label-model",
    labelId: "billing-label",
    confidence: 96,
  });
  assert.equal(model.doGenerateCalls.length, 1);
  assert.match(JSON.stringify(model.doGenerateCalls[0]?.prompt), /exactly one/i);
});

test("maps a model no-match to the persisted Others fallback", async () => {
  const { classify } = classifierWithOutput({
    selectedLabelId: null,
    confidence: 88,
  });

  assert.equal((await classify(baseInput)).labelId, "others-label");
});

test("rejects unknown output and duplicate input label IDs", async () => {
  const { classify } = classifierWithOutput({
    selectedLabelId: "unknown-label",
    confidence: 50,
  });
  await assert.rejects(
    classify(baseInput),
    (error: unknown) =>
      error instanceof ThreadLabelClassificationContractError &&
      /Unknown selected label ID/.test(error.message),
  );

  await assert.rejects(
    classify({
      ...baseInput,
      labelDefinitions: [
        baseInput.labelDefinitions[0],
        { ...baseInput.labelDefinitions[1], id: "important-label" },
      ],
    }),
    (error: unknown) =>
      error instanceof ThreadLabelClassificationContractError &&
      /Duplicate label definition ID/.test(error.message),
  );
});

test("uses Others without calling a model when every candidate is disabled", async () => {
  let modelCreationCount = 0;
  const model = classifierWithOutput({ selectedLabelId: null, confidence: 100 }).model;
  const classify = createStoredThreadLabelClassifier(() => {
    modelCreationCount += 1;
    return { model, modelId: "unused" };
  });

  const result = await classify({ ...baseInput, labelDefinitions: [] });

  assert.equal(result.labelId, "others-label");
  assert.equal(modelCreationCount, 0);
});

test("classifier input hashes match the exact clipped thread payload", () => {
  const originalHash = createStoredThreadLabelInputHash(baseInput.thread);
  const changedHash = createStoredThreadLabelInputHash({
    ...baseInput.thread,
    messages: baseInput.thread.messages.map((message) => ({
      ...message,
      bodyText: "A different invoice body.",
    })),
  });
  const clippedTailHash = createStoredThreadLabelInputHash({
    ...baseInput.thread,
    messages: [
      {
        ...baseInput.thread.messages[0],
        bodyText: "This message is outside the model's final twenty messages.",
      },
      ...Array.from({ length: 20 }, () => baseInput.thread.messages[0]),
    ],
  });
  const tailHash = createStoredThreadLabelInputHash({
    ...baseInput.thread,
    messages: Array.from({ length: 20 }, () => baseInput.thread.messages[0]),
  });

  assert.notEqual(changedHash, originalHash);
  assert.equal(clippedTailHash, tailHash);
});
