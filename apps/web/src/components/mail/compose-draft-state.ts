import type { GmailComposeSendAttempt } from "@/lib/api/gmail-compose-send";

type ComposeDraftStatus =
  | "editing"
  | "sending"
  | "sent"
  | "error"
  | "send_error"
  | "reconnect_required";

export type ComposeDraftEditableField =
  | "recipients"
  | "ccRecipients"
  | "bccRecipients"
  | "subject"
  | "body";

export interface ComposeDraftState {
  recipients: string;
  ccRecipients: string;
  bccRecipients: string;
  subject: string;
  body: string;
  attempt: GmailComposeSendAttempt | null;
  status: ComposeDraftStatus;
  message: string | null;
}

export type ComposeDraftAction =
  | { type: "edit"; field: ComposeDraftEditableField; value: string }
  | { type: "change_sender" }
  | { type: "sending"; attempt: GmailComposeSendAttempt }
  | {
      type: "attempt_saved";
      attempt: Extract<GmailComposeSendAttempt, { phase: "send" }>;
    }
  | { type: "sent" }
  | { type: "error"; message: string }
  | { type: "send_error"; message: string; isReconnectRequired: boolean };

export function createComposeDraftState(): ComposeDraftState {
  return {
    recipients: "",
    ccRecipients: "",
    bccRecipients: "",
    subject: "",
    body: "",
    attempt: null,
    status: "editing",
    message: null,
  };
}

// A send whose Gmail draft already exists has an unresolved provider outcome:
// only an identical retry may resolve it, so the message must stay frozen.
export function isComposeDraftLocked(state: ComposeDraftState): boolean {
  return (
    state.attempt?.phase === "send" ||
    ["sending", "sent", "reconnect_required"].includes(state.status)
  );
}

export function composeDraftReducer(
  state: ComposeDraftState,
  action: ComposeDraftAction,
): ComposeDraftState {
  switch (action.type) {
    case "edit":
      if (isComposeDraftLocked(state)) return state;
      return {
        ...state,
        [action.field]: action.value,
        attempt: null,
        status: "editing",
        message: null,
      };
    case "change_sender":
      if (isComposeDraftLocked(state)) return state;
      return { ...state, attempt: null, status: "editing", message: null };
    case "sending":
      return {
        ...state,
        attempt: action.attempt,
        status: "sending",
        message: null,
      };
    case "attempt_saved":
      return { ...state, attempt: action.attempt };
    case "sent":
      return {
        ...state,
        attempt: null,
        status: "sent",
        message: null,
      };
    case "error":
      return { ...state, status: "error", message: action.message };
    case "send_error":
      return {
        ...state,
        status: action.isReconnectRequired
          ? "reconnect_required"
          : "send_error",
        message: action.message,
      };
    default: {
      const exhaustiveAction: never = action;
      return exhaustiveAction;
    }
  }
}
