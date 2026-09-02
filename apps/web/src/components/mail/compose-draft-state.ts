import type { GmailComposeDraft } from "@invook/contracts";

type ComposeDraftStatus =
  | "editing"
  | "saving"
  | "saved"
  | "confirming_send"
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
  idempotencyKey: string;
  sendIdempotencyKey: string | null;
  providerDraft: GmailComposeDraft | null;
  status: ComposeDraftStatus;
  message: string | null;
}

export type ComposeDraftAction =
  | {
      type: "edit";
      field: ComposeDraftEditableField;
      value: string;
      idempotencyKey: string;
    }
  | { type: "change_sender"; idempotencyKey: string }
  | { type: "saving" }
  | {
      type: "saved";
      draft: GmailComposeDraft;
      sendIdempotencyKey: string;
    }
  | { type: "error"; message: string; isReconnectRequired?: boolean }
  | { type: "confirm_send" }
  | { type: "cancel_send" }
  | { type: "sending" }
  | { type: "sent" }
  | { type: "send_error"; message: string; isReconnectRequired: boolean };

export function createComposeDraftState(idempotencyKey: string): ComposeDraftState {
  return {
    recipients: "",
    ccRecipients: "",
    bccRecipients: "",
    subject: "",
    body: "",
    idempotencyKey,
    sendIdempotencyKey: null,
    providerDraft: null,
    status: "editing",
    message: null,
  };
}

export function composeDraftReducer(
  state: ComposeDraftState,
  action: ComposeDraftAction,
): ComposeDraftState {
  switch (action.type) {
    case "edit":
      return {
        ...state,
        [action.field]: action.value,
        idempotencyKey: action.idempotencyKey,
        sendIdempotencyKey: null,
        status: "editing",
        message: null,
      };
    case "change_sender":
      return {
        ...state,
        idempotencyKey: action.idempotencyKey,
        sendIdempotencyKey: null,
        status: "editing",
        message: null,
      };
    case "saving":
      return { ...state, status: "saving", message: null };
    case "saved":
      return {
        ...state,
        providerDraft: action.draft,
        sendIdempotencyKey: action.sendIdempotencyKey,
        status: "saved",
        message:
          "Saved to Gmail drafts. Invook will reflect it here after Gmail history catches up.",
      };
    case "error":
      return {
        ...state,
        status: action.isReconnectRequired ? "reconnect_required" : "error",
        message: action.message,
      };
    case "confirm_send":
      return { ...state, status: "confirming_send", message: null };
    case "cancel_send":
      return { ...state, status: "saved", message: null };
    case "sending":
      return { ...state, status: "sending", message: null };
    case "sent":
      return {
        ...state,
        status: "sent",
        message: "Sent with Gmail. Invook will reflect it here after Gmail history catches up.",
      };
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
