import assert from "node:assert/strict";
import test from "node:test";

import {
  GMAIL_COMPOSE_MAX_BODY_LENGTH,
  parseGmailComposeRecipients,
  validateGmailComposeDraftFields,
} from "./gmail-compose";

test("compose recipients are parsed as an explicit comma-separated list", () => {
  assert.deepEqual(
    parseGmailComposeRecipients("first@example.com, second@example.com"),
    ["first@example.com", "second@example.com"],
  );
  assert.deepEqual(parseGmailComposeRecipients("  "), []);
});

test("forward validation limits only authored text and permits a quote-only forward", () => {
  const fields = {
    recipients: ["recipient@example.com"],
    subject: "Fwd: Subject",
    body: "",
  };
  const source = { forwardOfMessageId: "message-1" };
  for (const body of ["", " \n ", "x".repeat(GMAIL_COMPOSE_MAX_BODY_LENGTH)]) {
    assert.equal(
      validateGmailComposeDraftFields({ ...fields, body }, source).valid,
      true,
    );
  }
  const oversized = validateGmailComposeDraftFields(
    {
      ...fields,
      body: "x".repeat(GMAIL_COMPOSE_MAX_BODY_LENGTH + 1),
    },
    source,
  );
  assert.equal(oversized.valid, false);
  if (!oversized.valid) assert.equal(oversized.error.field, "body");
  assert.equal(validateGmailComposeDraftFields(fields).valid, false);
  assert.equal(
    validateGmailComposeDraftFields(fields, { replyToMessageId: "message-1" })
      .valid,
    false,
  );
});

test("compose validation rejects invalid and duplicate recipients", () => {
  const invalid = validateGmailComposeDraftFields({
    recipients: ["not-an-email"],
    subject: "Subject",
    body: "Body",
  });
  assert.deepEqual(invalid, {
    valid: false,
    error: {
      field: "recipients",
      message: "Enter valid email addresses separated by commas.",
    },
  });

  const duplicate = validateGmailComposeDraftFields({
    recipients: ["person@example.com", "PERSON@example.com"],
    subject: "Subject",
    body: "Body",
  });
  assert.equal(duplicate.valid, false);
  if (!duplicate.valid) assert.equal(duplicate.error.field, "recipients");
});

test("compose validation rejects header injection and empty bodies", () => {
  const injected = validateGmailComposeDraftFields({
    recipients: ["person@example.com"],
    subject: "Subject\r\nBcc: hidden@example.com",
    body: "Body",
  });
  assert.equal(injected.valid, false);
  if (!injected.valid) assert.equal(injected.error.field, "subject");

  const emptyBody = validateGmailComposeDraftFields({
    recipients: ["person@example.com"],
    subject: "",
    body: " \n ",
  });
  assert.equal(emptyBody.valid, false);
  if (!emptyBody.valid) assert.equal(emptyBody.error.field, "body");
});

test("compose validation preserves valid user-authored subject and body text", () => {
  const result = validateGmailComposeDraftFields({
    recipients: [" person@example.com "],
    subject: "Quarterly update",
    body: "First line\nSecond line",
  });
  assert.deepEqual(result, {
    valid: true,
    fields: {
      recipients: ["person@example.com"],
      subject: "Quarterly update",
      body: "First line\nSecond line",
    },
  });
});

test("Cc and Bcc share validation, deduplication, and total recipient limits", () => {
  const fields = {
    recipients: ["to@example.com"],
    subject: "Subject",
    body: "Body",
  };
  assert.deepEqual(
    validateGmailComposeDraftFields({
      ...fields,
      ccRecipients: [" cc@example.com "],
      bccRecipients: ["private@example.com"],
    }),
    {
      valid: true,
      fields: {
        ...fields,
        ccRecipients: ["cc@example.com"],
        bccRecipients: ["private@example.com"],
      },
    },
  );
  for (const field of ["ccRecipients", "bccRecipients"] as const) {
    assert.equal(
      validateGmailComposeDraftFields({
        ...fields,
        [field]: ["TO@example.com"],
      }).valid,
      false,
    );
    const invalid = validateGmailComposeDraftFields({
      ...fields,
      [field]: ["bad\r\nBcc: address"],
    });
    assert.equal(invalid.valid, false);
    if (!invalid.valid) assert.equal(invalid.error.field, field);
    assert.equal(
      validateGmailComposeDraftFields({
        ...fields,
        [field]: Array.from(
          { length: 50 },
          (_, index) => `person${index}@example.com`,
        ),
      }).valid,
      false,
    );
  }
});
