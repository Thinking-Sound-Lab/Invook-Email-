import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GmailApiError,
  GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
} from "@invook/gmail";

import { classifyGmailWorkflowFailure } from "./workflow-failure";

test("permanent Google authentication failure stops retries immediately", () => {
  const failure = classifyGmailWorkflowFailure(
    new GmailApiError("Google rejected the refresh token.", 400, "redacted", {
      path: "https://oauth2.googleapis.com/token",
      code: "invalid_grant",
    }),
    { attempt: 1, maxAttempts: 5 },
  );

  assert.deepEqual(failure, {
    isTerminal: true,
    isReconnectRequired: true,
    persistedMessage: GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
  });
});

test("transient Google provider failure remains retryable", () => {
  const failure = classifyGmailWorkflowFailure(
    new GmailApiError("Google is unavailable.", 503, "redacted"),
    { attempt: 1, maxAttempts: 5 },
  );

  assert.deepEqual(failure, {
    isTerminal: false,
    isReconnectRequired: false,
    persistedMessage: "Google is unavailable.",
  });
});

test("transient Google provider failure becomes terminal at the retry limit", () => {
  const failure = classifyGmailWorkflowFailure(
    new GmailApiError("Google is unavailable.", 503, "redacted"),
    { attempt: 5, maxAttempts: 5 },
  );

  assert.equal(failure.isTerminal, true);
  assert.equal(failure.isReconnectRequired, false);
});
