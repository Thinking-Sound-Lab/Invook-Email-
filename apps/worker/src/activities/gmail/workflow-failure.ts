import {
  GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE,
  isGoogleReauthenticationRequired,
} from "@invook/gmail";

export type GmailWorkflowFailure = {
  isTerminal: boolean;
  isReconnectRequired: boolean;
  persistedMessage: string;
};

export function classifyGmailWorkflowFailure(
  error: unknown,
  input: { attempt: number; maxAttempts: number },
): GmailWorkflowFailure {
  const isReconnectRequired = isGoogleReauthenticationRequired(error);
  return {
    isTerminal: isReconnectRequired || input.attempt >= input.maxAttempts,
    isReconnectRequired,
    persistedMessage: isReconnectRequired
      ? GOOGLE_REAUTHENTICATION_REQUIRED_ERROR_CODE
      : error instanceof Error
        ? error.message
        : "Unknown worker failure",
  };
}
