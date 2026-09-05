export const GMAIL_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;

export const GMAIL_SCOPE_DESCRIPTION = [
  "Read and index your Gmail messages",
  "Create, send, and organize mail on your behalf",
] as const;
