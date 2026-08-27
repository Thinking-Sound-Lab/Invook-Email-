export interface ComposeSenderAccountState {
  accountId: string;
  binding: "editable" | "save_attempt";
}

export function createComposeSenderAccountState(
  accountId: string,
): ComposeSenderAccountState {
  return { accountId, binding: "editable" };
}

export function resolveComposeSenderAccountId(input: {
  state: ComposeSenderAccountState;
  scopedAccountId: string | null;
}): string {
  return input.state.binding === "save_attempt" || !input.scopedAccountId
    ? input.state.accountId
    : input.scopedAccountId;
}

export function selectComposeSenderAccount(
  accountId: string,
): ComposeSenderAccountState {
  return { accountId, binding: "editable" };
}

export function bindComposeSenderAccount(
  accountId: string,
): ComposeSenderAccountState {
  return { accountId, binding: "save_attempt" };
}

export function releaseComposeSenderAccount(
  state: ComposeSenderAccountState,
  options: { hasProviderDraft: boolean },
): ComposeSenderAccountState {
  if (options.hasProviderDraft || state.binding === "editable") return state;
  return { ...state, binding: "editable" };
}
