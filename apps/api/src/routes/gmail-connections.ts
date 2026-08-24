import { randomBytes } from "node:crypto";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { validate as validateUuid } from "uuid";

import {
  consumeGmailConnectionRequest,
  createGmailConnectionRequest,
  decryptGoogleCredential,
  encryptGoogleCredential,
  getGmailConnectionForOAuth,
  getGmailConnectionForUser,
  refreshGmailAuthentication,
  saveNewGmailConnection,
} from "@invook/database";
import {
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  getGmailProfile,
  GmailApiError,
  startGmailWatch,
} from "@invook/gmail";

import { requireSession } from "../access";
import {
  getMissingGmailConnectionConfiguration,
  getPublicAppOrigin,
} from "../config";
import { sendProblem, sendRedirect } from "../responses";

const CONNECTION_REQUEST_DURATION_MILLISECONDS = 10 * 60 * 1_000;

type ConnectionErrorReason =
  | "already_connected"
  | "authorization"
  | "configuration"
  | "gmail_access"
  | "mailbox_mismatch"
  | "offline_access"
  | "unknown";

type StartQuery = { accountId?: unknown };

type CallbackQuery = {
  error?: unknown;
  code?: unknown;
  state?: unknown;
};

interface GmailConnectionIdentity {
  id: string;
  userId: string;
  providerAccountId: string;
}

export function getGmailConnectionIdentityError(input: {
  userId: string;
  providerAccountId: string;
  reconnectAccount: GmailConnectionIdentity | null;
  existingAccount: { id: string; userId: string } | null;
}): "already_connected" | "mailbox_mismatch" | null {
  if (
    input.reconnectAccount &&
    (input.reconnectAccount.userId !== input.userId ||
      input.reconnectAccount.providerAccountId !== input.providerAccountId ||
      input.existingAccount?.id !== input.reconnectAccount.id)
  ) {
    return "mailbox_mismatch";
  }
  if (input.existingAccount && input.existingAccount.userId !== input.userId) {
    return "already_connected";
  }
  return null;
}

function connectionErrorUrl(reason: ConnectionErrorReason): string {
  const target = new URL("/auth/error", getPublicAppOrigin());
  target.searchParams.set("reason", reason);
  return target.toString();
}

function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

async function handleGmailStart(
  request: FastifyRequest<{ Querystring: StartQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const session = request.invookSession;
  if (!session) return;

  if (getMissingGmailConnectionConfiguration().length > 0) {
    await sendRedirect(reply, connectionErrorUrl("configuration"), 302);
    return;
  }

  const requestedAccountId = request.query.accountId;
  if (
    requestedAccountId !== undefined &&
    (typeof requestedAccountId !== "string" || !validateUuid(requestedAccountId))
  ) {
    await sendProblem(request, reply, 400, "Invalid Gmail account ID");
    return;
  }

  const accountId =
    typeof requestedAccountId === "string" ? requestedAccountId : null;
  if (accountId) {
    const account = await getGmailConnectionForUser({
      userId: session.userId,
      accountId,
    });
    if (!account) {
      await sendProblem(request, reply, 404, "Gmail account not found");
      return;
    }
  }

  const state = createOAuthState();
  const authorization = await createGoogleAuthorizationRequest({
    clientId: process.env.GMAIL_GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GMAIL_GOOGLE_CLIENT_SECRET ?? "",
    redirectUri: `${getPublicAppOrigin()}/connections/gmail/callback`,
    state,
  });
  await createGmailConnectionRequest({
    state,
    codeVerifier: authorization.codeVerifier,
    userId: session.userId,
    accountId,
    expiresAt: new Date(
      Date.now() + CONNECTION_REQUEST_DURATION_MILLISECONDS,
    ),
  });
  await sendRedirect(reply, authorization.url, 302);
}

async function handleGmailCallback(
  request: FastifyRequest<{ Querystring: CallbackQuery }>,
  reply: FastifyReply,
): Promise<void> {
  const session = request.invookSession;
  if (!session) return;

  const providerError =
    typeof request.query.error === "string" ? request.query.error : null;
  const code = typeof request.query.code === "string" ? request.query.code : null;
  const returnedState =
    typeof request.query.state === "string" ? request.query.state : null;
  const connectionRequest = returnedState
    ? await consumeGmailConnectionRequest({
        state: returnedState,
        consumedAt: new Date(),
      })
    : null;

  if (
    providerError ||
    !code ||
    !connectionRequest ||
    connectionRequest.userId !== session.userId
  ) {
    await sendRedirect(reply, connectionErrorUrl("authorization"), 302);
    return;
  }

  try {
    const authorization = await exchangeGoogleAuthorizationCode({
      clientId: process.env.GMAIL_GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GMAIL_GOOGLE_CLIENT_SECRET ?? "",
      redirectUri: `${getPublicAppOrigin()}/connections/gmail/callback`,
      code,
      codeVerifier: connectionRequest.codeVerifier,
    });
    const gmailProfile = await getGmailProfile(authorization.accessToken);
    const providerAccountId = authorization.identity.subject;
    const existingAccount = await getGmailConnectionForOAuth(providerAccountId);

    const reconnectAccount = connectionRequest.accountId
      ? await getGmailConnectionForUser({
        userId: session.userId,
        accountId: connectionRequest.accountId,
      })
      : null;
    if (connectionRequest.accountId && !reconnectAccount) {
      await sendRedirect(reply, connectionErrorUrl("mailbox_mismatch"), 302);
      return;
    }
    const identityError = getGmailConnectionIdentityError({
      userId: session.userId,
      providerAccountId,
      reconnectAccount,
      existingAccount,
    });
    if (identityError) {
      await sendRedirect(reply, connectionErrorUrl(identityError), 302);
      return;
    }

    let refreshToken = authorization.refreshToken;
    if (!refreshToken && existingAccount?.tokenCiphertext) {
      refreshToken = decryptGoogleCredential(
        existingAccount.tokenCiphertext,
        process.env.TOKEN_ENCRYPTION_KEY ?? "",
      ).refreshToken;
    }
    if (!refreshToken) {
      await sendRedirect(reply, connectionErrorUrl("offline_access"), 302);
      return;
    }

    const authenticatedAt = new Date();
    const tokenCiphertext = encryptGoogleCredential(
      {
        accessToken: authorization.accessToken,
        refreshToken,
        expiresAt: authorization.expiresAt,
        scopes: authorization.scopes,
      },
      process.env.TOKEN_ENCRYPTION_KEY ?? "",
    );
    const authentication = {
      userId: session.userId,
      providerAccountId,
      email: gmailProfile.emailAddress,
      image: authorization.identity.image,
      scopes: authorization.scopes,
      currentHistoryId: gmailProfile.historyId,
      tokenCiphertext,
      authenticatedAt,
    };
    let account = existingAccount
      ? await refreshGmailAuthentication(authentication)
      : null;
    if (!account) {
      const topicName = process.env.GMAIL_PUBSUB_TOPIC;
      if (!topicName) {
        throw new Error("GMAIL_PUBSUB_TOPIC is required to connect Gmail.");
      }
      const watch = await startGmailWatch(authorization.accessToken, {
        topicName,
      });
      const watchExpiration = Number(watch.expiration);
      if (!Number.isFinite(watchExpiration)) {
        throw new Error("Gmail returned an invalid watch expiration.");
      }
      const watchRenewedAt = new Date();
      account = await saveNewGmailConnection({
        ...authentication,
        initialHistoryId: gmailProfile.historyId,
        watch: {
          topicName,
          historyId: watch.historyId,
          expirationAt: new Date(watchExpiration),
          renewedAt: watchRenewedAt,
        },
      });
    }

    const mailboxUrl = new URL("/mail", getPublicAppOrigin());
    mailboxUrl.searchParams.set("account", account.id);
    await sendRedirect(reply, mailboxUrl.toString(), 302);
  } catch (error) {
    console.error("api: gmail connection callback failed", {
      requestId: request.id,
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown callback failure",
      status: error instanceof GmailApiError ? error.status : undefined,
    });
    await sendRedirect(
      reply,
      connectionErrorUrl(
        error instanceof GmailApiError && error.status === 403
          ? "gmail_access"
          : "unknown",
      ),
      302,
    );
  }
}

export const registerGmailConnectionRoutes: FastifyPluginAsync = async (api) => {
  api.get<{ Querystring: StartQuery }>(
    "/v1/connections/gmail/start",
    { onRequest: requireSession },
    handleGmailStart,
  );

  api.get<{ Querystring: CallbackQuery }>(
    "/v1/connections/gmail/callback",
    { onRequest: requireSession },
    handleGmailCallback,
  );
};
