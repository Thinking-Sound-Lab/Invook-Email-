export const GMAIL_COMPOSE_MAX_RECIPIENTS = 50;
export const GMAIL_COMPOSE_MAX_SUBJECT_LENGTH = 998;
export const GMAIL_COMPOSE_MAX_BODY_LENGTH = 10_000;

export type GmailComposeDraftFields = {
  recipients: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  subject: string;
  body: string;
};

export type GmailComposeDraftValidationError = {
  field: "recipients" | "ccRecipients" | "bccRecipients" | "subject" | "body";
  message: string;
};

export type GmailComposeDraftValidationResult =
  | { valid: true; fields: GmailComposeDraftFields }
  | { valid: false; error: GmailComposeDraftValidationError };

export type GmailComposeDraftSource =
  | { replyToMessageId?: string; forwardOfMessageId?: never }
  | { replyToMessageId?: never; forwardOfMessageId: string };

export type CreateGmailComposeDraftRequest = GmailComposeDraftFields &
  GmailComposeDraftSource & {
    accountId: string;
    idempotencyKey: string;
  };

export type UpdateGmailComposeDraftRequest = CreateGmailComposeDraftRequest;

export type SendGmailComposeDraftRequest = {
  accountId: string;
  idempotencyKey: string;
};

export type GmailComposeDraft = {
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
};

export type GmailComposeDraftResponse = {
  draft: GmailComposeDraft;
  stepId: string;
};

export type GmailComposeSentMessage = {
  providerMessageId: string;
  providerThreadId: string;
};

export type GmailComposeSendResponse = {
  message: GmailComposeSentMessage;
  stepId: string;
};

const EMAIL_ADDRESS_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/;
const HEADER_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export function parseGmailComposeRecipients(value: string): string[] {
  if (!value.trim()) return [];
  return value.split(",").map((recipient) => recipient.trim());
}

export function validateGmailComposeDraftFields(
  input: GmailComposeDraftFields,
  source: GmailComposeDraftSource = {},
): GmailComposeDraftValidationResult {
  if (
    input.recipients.length === 0 ||
    input.recipients.some((recipient) => !recipient)
  ) {
    return {
      valid: false,
      error: {
        field: "recipients",
        message: "Enter at least one recipient email address.",
      },
    };
  }
  const allRecipients = [
    ...input.recipients,
    ...(input.ccRecipients ?? []),
    ...(input.bccRecipients ?? []),
  ];
  if (allRecipients.length > GMAIL_COMPOSE_MAX_RECIPIENTS) {
    return {
      valid: false,
      error: {
        field: "recipients",
        message: `Enter no more than ${GMAIL_COMPOSE_MAX_RECIPIENTS} recipients.`,
      },
    };
  }

  const normalizedRecipients = input.recipients.map((recipient) =>
    recipient.trim(),
  );
  for (const field of [
    "recipients",
    "ccRecipients",
    "bccRecipients",
  ] as const) {
    if (
      (input[field] ?? []).some(
        (recipient) =>
          recipient.length > 254 ||
          HEADER_CONTROL_PATTERN.test(recipient) ||
          !EMAIL_ADDRESS_PATTERN.test(recipient.trim()),
      )
    ) {
      return {
        valid: false,
        error: {
          field,
          message: "Enter valid email addresses separated by commas.",
        },
      };
    }
  }

  const uniqueRecipients = new Set(
    allRecipients.map((recipient) =>
      recipient.trim().toLocaleLowerCase("en-US"),
    ),
  );
  if (uniqueRecipients.size !== allRecipients.length) {
    return {
      valid: false,
      error: {
        field: "recipients",
        message: "Remove duplicate recipient email addresses.",
      },
    };
  }

  if (
    input.subject.length > GMAIL_COMPOSE_MAX_SUBJECT_LENGTH ||
    HEADER_CONTROL_PATTERN.test(input.subject)
  ) {
    return {
      valid: false,
      error: {
        field: "subject",
        message: `Subject must be ${GMAIL_COMPOSE_MAX_SUBJECT_LENGTH} characters or fewer and contain no line breaks.`,
      },
    };
  }

  if (!input.body.trim() && !source.forwardOfMessageId) {
    return {
      valid: false,
      error: { field: "body", message: "Enter a message body." },
    };
  }
  if (input.body.length > GMAIL_COMPOSE_MAX_BODY_LENGTH) {
    return {
      valid: false,
      error: {
        field: "body",
        message: `Message body must be ${GMAIL_COMPOSE_MAX_BODY_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      },
    };
  }

  return {
    valid: true,
    fields: {
      recipients: normalizedRecipients,
      ...(input.ccRecipients !== undefined
        ? {
            ccRecipients: input.ccRecipients.map((recipient) =>
              recipient.trim(),
            ),
          }
        : {}),
      ...(input.bccRecipients !== undefined
        ? {
            bccRecipients: input.bccRecipients.map((recipient) =>
              recipient.trim(),
            ),
          }
        : {}),
      subject: input.subject,
      body: input.body,
    },
  };
}
