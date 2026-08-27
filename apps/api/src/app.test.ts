import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";

import type { FastifyInstance } from "fastify";
import { validate as validateUuid } from "uuid";

import type { InvookSession } from "@invook/auth";
import { LABEL_PREVIEW_STALE_ERROR } from "@invook/contracts";
import {
  LabelMutationError,
  LabelPreviewReceiptConflictError,
} from "@invook/database";
import { composePlainTextGmailReply } from "@invook/gmail";
import { ObjectStorageObjectNotFoundError } from "@invook/object-storage";

import { buildApi } from "./app";
import type { AuthService } from "./auth/auth-service";
import { getGmailConnectionIdentityError } from "./routes/gmail-connections";
import { parseGmailNotification } from "./routes/google-pubsub";

let api: FastifyInstance;
const originalAppUrl = process.env.APP_URL;
const originalOpenAiWebhookSecret = process.env.OPENAI_WEBHOOK_SECRET;
const originalGooglePubSubAudience = process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
const originalGooglePubSubServiceAccountEmail =
  process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
const originalGooglePubSubSubscription = process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
const originalTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
const attachmentOwnerId = "11111111-1111-4111-8111-111111111111";
const otherUserId = "22222222-2222-4222-8222-222222222222";
const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const missingObjectAttachmentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const absentAttachmentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const attachmentBytes = Buffer.from([0, 1, 2, 253, 254, 255]);
const attachmentChecksum = createHash("sha256").update(attachmentBytes).digest("hex");
let attachmentObjectReadCount = 0;

function getTestSession(headers: Headers): InvookSession | null {
  const cookie = headers.get("cookie") ?? "";
  const userId = cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("test_session="))
    ?.slice("test_session=".length);
  if (!userId) return null;

  return {
    userId,
    user: {
      email: `${userId}@example.com`,
      image: null,
      name: "Test User",
    },
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const testAuth: AuthService = {
  getSession: async (headers) => getTestSession(headers),
  handle: async (request) => {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/auth/sign-out") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie":
            "invook.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
        },
      });
    }
    return new Response(JSON.stringify({ message: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  },
};

before(async () => {
  process.env.APP_URL = "http://localhost:3000";
  delete process.env.OPENAI_WEBHOOK_SECRET;
  delete process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
  delete process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
  delete process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  api = await buildApi({
    auth: testAuth,
    attachmentRoutes: {
      getAttachment: async ({ userId, attachmentId: requestedAttachmentId }) => {
        if (userId !== attachmentOwnerId || requestedAttachmentId === absentAttachmentId) {
          return null;
        }
        if (
          requestedAttachmentId !== attachmentId &&
          requestedAttachmentId !== missingObjectAttachmentId
        ) {
          return null;
        }
        return {
          id: requestedAttachmentId,
          filename: 'folder/résumé\r\n".pdf',
          mimeType: "text/html",
          objectKey:
            requestedAttachmentId === missingObjectAttachmentId
              ? "attachments/missing"
              : "attachments/owned",
          checksumSha256: attachmentChecksum,
          contentLength: attachmentBytes.byteLength,
          etag: null,
        };
      },
      readObject: async (objectKey) => {
        attachmentObjectReadCount += 1;
        if (objectKey === "attachments/missing") {
          throw new ObjectStorageObjectNotFoundError();
        }
        return attachmentBytes;
      },
    },
  });
});

after(async () => {
  await api.close();
  if (originalAppUrl === undefined) {
    delete process.env.APP_URL;
  } else {
    process.env.APP_URL = originalAppUrl;
  }
  if (originalOpenAiWebhookSecret === undefined) {
    delete process.env.OPENAI_WEBHOOK_SECRET;
  } else {
    process.env.OPENAI_WEBHOOK_SECRET = originalOpenAiWebhookSecret;
  }
  if (originalGooglePubSubAudience === undefined) {
    delete process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
  } else {
    process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE = originalGooglePubSubAudience;
  }
  if (originalGooglePubSubServiceAccountEmail === undefined) {
    delete process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
  } else {
    process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL =
      originalGooglePubSubServiceAccountEmail;
  }
  if (originalGooglePubSubSubscription === undefined) {
    delete process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  } else {
    process.env.GOOGLE_PUBSUB_SUBSCRIPTION = originalGooglePubSubSubscription;
  }
  if (originalTokenEncryptionKey === undefined) {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  } else {
    process.env.TOKEN_ENCRYPTION_KEY = originalTokenEncryptionKey;
  }
});

async function sessionCookie(userId: string): Promise<string> {
  return `test_session=${userId}`;
}

test("liveness uses the existing response contract", async () => {
  const response = await api.inject({ method: "GET", url: "/health/live" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(validateUuid(response.headers["x-request-id"] ?? ""), true);
  assert.match(String(response.headers["server-timing"] ?? ""), /^api;dur=\d+\.\d$/);
});

test("the reverse proxy request ID and trailing slash are preserved", async () => {
  const response = await api.inject({
    method: "GET",
    url: "/health/live/",
    headers: { "x-request-id": "request-from-proxy" },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-request-id"], "request-from-proxy");
});

test("an anonymous session remains an honest disconnected state", async () => {
  const response = await api.inject({ method: "GET", url: "/v1/session" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    authenticated: false,
    gmailConnected: false,
  });
});

test("signing out clears only the browser session cookie", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/auth/sign-out",
  });

  const setCookie = response.headers["set-cookie"];
  const sessionCookie = Array.isArray(setCookie)
    ? setCookie.join("; ")
    : setCookie ?? "";
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { success: true });
  assert.match(sessionCookie, /^invook\.session_token=;/);
  assert.match(sessionCookie, /Max-Age=0/);
});

test("global Google authentication rejects caller-supplied Gmail scopes", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/auth/sign-in/social",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    }),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json().title,
    "Google authentication accepts identity scopes only",
  );
});

test("authentication runs before JSON body parsing", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/labels",
    headers: { "content-type": "application/json" },
    payload: "{",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("custom label edits require authentication", async () => {
  const response = await api.inject({
    method: "PATCH",
    url: "/v1/labels/00000000-0000-4000-8000-000000000000",
    payload: { name: "Receipts", description: "Purchase receipts" },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("label enablement changes require authentication", async () => {
  const response = await api.inject({
    method: "PATCH",
    url: "/v1/labels/00000000-0000-4000-8000-000000000000/enabled",
    payload: { isEnabled: false },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("custom label previews require authentication", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/labels/preview",
    payload: { name: "Security", description: "Account security notices" },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("custom label creation accepts only supported historical windows", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/labels",
    headers: { cookie: await sessionCookie(attachmentOwnerId) },
    payload: {
      accountId: attachmentOwnerId,
      name: "Security",
      description: "Account security notices",
      applyToPastDays: 14,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().title, "Past-email window must be 7, 30, or 90 days");
});

test("custom label creation validates and forwards the preview receipt", async () => {
  const previewReceiptId = "33333333-3333-4333-8333-333333333333";
  let admittedPreviewReceiptId: string | null | undefined;
  const receiptApi = await buildApi({
    auth: testAuth,
    labelRoutes: {
      createLabel: async (input) => {
        admittedPreviewReceiptId = input.previewReceiptId;
        return {
          id: "44444444-4444-4444-8444-444444444444",
          name: input.name,
          description: input.description,
          systemKey: null,
          definitionVersion: 1,
          isEnabled: true,
          historicalAnalysis: { windowDays: 90, status: "queued" },
        };
      },
    },
  });
  try {
    const response = await receiptApi.inject({
      method: "POST",
      url: "/v1/labels",
      headers: { cookie: await sessionCookie(attachmentOwnerId) },
      payload: {
        accountId: attachmentOwnerId,
        name: "Security",
        description: "Account security notices",
        applyToPastDays: 90,
        previewReceiptId,
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(admittedPreviewReceiptId, previewReceiptId);

    const invalid = await receiptApi.inject({
      method: "POST",
      url: "/v1/labels",
      headers: { cookie: await sessionCookie(attachmentOwnerId) },
      payload: {
        accountId: attachmentOwnerId,
        name: "Security",
        description: "Account security notices",
        applyToPastDays: 90,
        previewReceiptId: "not-a-uuid",
      },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().title, "Label preview ID must be valid");
  } finally {
    await receiptApi.close();
  }
});

test("label previews return their reusable receipt contract", async () => {
  const previewReceiptId = "55555555-5555-4555-8555-555555555555";
  const previewApi = await buildApi({
    auth: testAuth,
    labelRoutes: {
      previewLabel: async () => ({
        previewReceiptId,
        expiresAt: "2026-08-24T12:15:00.000Z",
        scannedThreadCount: 1,
        matches: [{
          threadId: "66666666-6666-4666-8666-666666666666",
          sender: "billing@example.com",
          subject: "Invoice",
          sentAt: "2026-08-24T12:00:00.000Z",
          confidence: 96,
        }],
      }),
    },
  });
  try {
    const response = await previewApi.inject({
      method: "POST",
      url: "/v1/labels/preview",
      headers: { cookie: await sessionCookie(attachmentOwnerId) },
      payload: {
        accountId: attachmentOwnerId,
        name: "Billing",
        description: "Invoices and purchase receipts",
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().previewReceiptId, previewReceiptId);
    assert.equal(response.json().scannedThreadCount, 1);
  } finally {
    await previewApi.close();
  }
});

test("a stale preview returns a stable conflict without exposing database detail", async () => {
  const staleApi = await buildApi({
    auth: testAuth,
    labelRoutes: {
      createLabel: async () => {
        throw new LabelPreviewReceiptConflictError();
      },
    },
  });
  try {
    const response = await staleApi.inject({
      method: "POST",
      url: "/v1/labels",
      headers: { cookie: await sessionCookie(attachmentOwnerId) },
      payload: {
        accountId: attachmentOwnerId,
        name: "Security",
        description: "Account security notices",
        applyToPastDays: 7,
        previewReceiptId: "77777777-7777-4777-8777-777777777777",
      },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().title, LABEL_PREVIEW_STALE_ERROR);
    assert.equal(response.json().requestId, response.headers["x-request-id"]);
  } finally {
    await staleApi.close();
  }
});

test("label admission failures return a stable problem and private request log", async () => {
  const privateLogs: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...values: unknown[]) => {
    privateLogs.push(values);
  };
  const failingApi = await buildApi({
    auth: testAuth,
    labelRoutes: {
      createLabel: async () => {
        throw new LabelMutationError(
          "create",
          new Error("raw database detail must stay private"),
        );
      },
    },
  });
  try {
    const response = await failingApi.inject({
      method: "POST",
      url: "/v1/labels",
      headers: { cookie: await sessionCookie(attachmentOwnerId) },
      payload: {
        accountId: attachmentOwnerId,
        name: "Security",
        description: "Account security notices",
        applyToPastDays: 7,
      },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().title, "Label change could not be completed");
    assert.equal(response.json().requestId, response.headers["x-request-id"]);
    assert.equal(response.body.includes("raw database detail"), false);

    const privateLog = privateLogs.find(
      (entry) => entry[0] === "api: label mutation failed",
    );
    assert.ok(privateLog);
    const details = privateLog[1];
    assert.ok(details && typeof details === "object");
    assert.equal(
      "requestId" in details ? details.requestId : null,
      response.headers["x-request-id"],
    );
    assert.equal("operation" in details ? details.operation : null, "create");
    assert.equal("causeName" in details ? details.causeName : null, "Error");
  } finally {
    await failingApi.close();
    console.error = originalConsoleError;
  }
});

test("label re-enablement accepts only supported historical windows", async () => {
  const response = await api.inject({
    method: "PATCH",
    url: "/v1/labels/00000000-0000-4000-8000-000000000000/enabled",
    headers: { cookie: await sessionCookie(attachmentOwnerId) },
    payload: { isEnabled: true, applyToPastDays: 14 },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(
    response.json().title,
    "Enabled state and past-email window must be valid",
  );
});

test("mailbox refresh requires an authenticated session", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/mailbox/sync",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("focused mailbox reads require authentication and the workspace route is absent", async () => {
  for (const url of [
    "/v1/mailbox/shell",
    "/v1/mailbox/sidebar-counts",
    "/v1/mailbox/threads?view=all",
    "/v1/mailbox/settings",
  ]) {
    const response = await api.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, url);
  }
  const legacy = await api.inject({ method: "GET", url: "/v1/mailbox" });
  assert.equal(legacy.statusCode, 404);
});

test("Gmail add and callback routes require a Better Auth session", async () => {
  for (const url of [
    "/v1/connections/gmail/start",
    "/v1/connections/gmail/callback",
  ]) {
    const response = await api.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, url);
    assert.equal(response.json().title, "Authentication required");
  }
});

test("Gmail connection identities preserve user and reconnect ownership", () => {
  const currentUserId = attachmentOwnerId;
  const otherUserAccount = {
    id: attachmentId,
    userId: otherUserId,
  };
  assert.equal(
    getGmailConnectionIdentityError({
      userId: currentUserId,
      providerAccountId: "google-subject",
      reconnectAccount: null,
      existingAccount: otherUserAccount,
    }),
    "already_connected",
  );
  assert.equal(
    getGmailConnectionIdentityError({
      userId: currentUserId,
      providerAccountId: "different-google-subject",
      reconnectAccount: {
        id: attachmentId,
        userId: currentUserId,
        providerAccountId: "google-subject",
      },
      existingAccount: { id: attachmentId, userId: currentUserId },
    }),
    "mailbox_mismatch",
  );
});

test("mailbox deletion requires an authenticated session", async () => {
  const response = await api.inject({
    method: "DELETE",
    url: "/v1/mailbox/account",
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("attachment downloads require authentication and a valid attachment ID", async () => {
  const anonymous = await api.inject({
    method: "GET",
    url: `/v1/attachments/${attachmentId}/download`,
  });
  assert.equal(anonymous.statusCode, 401);

  const invalid = await api.inject({
    method: "GET",
    url: "/v1/attachments/not-a-uuid/download",
    headers: { cookie: await sessionCookie(attachmentOwnerId) },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().title, "Invalid attachment ID");
});

test("attachment downloads return exact stored bytes and safe private headers", async () => {
  const response = await api.inject({
    method: "GET",
    url: `/v1/attachments/${attachmentId}/download`,
    headers: { cookie: await sessionCookie(attachmentOwnerId) },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, attachmentBytes);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(response.headers["content-length"], String(attachmentBytes.byteLength));
  assert.equal(response.headers.etag, `"${attachmentChecksum}"`);
  assert.equal(response.headers["cache-control"], "private, no-cache");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(
    response.headers["content-disposition"] ?? "",
    /^attachment; filename="r_sum__\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9%22\.pdf$/,
  );
});

test("attachment lookup denies cross-user access before object storage", async () => {
  const readsBefore = attachmentObjectReadCount;
  const response = await api.inject({
    method: "GET",
    url: `/v1/attachments/${attachmentId}/download`,
    headers: { cookie: await sessionCookie(otherUserId) },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().title, "Attachment not found");
  assert.equal(attachmentObjectReadCount, readsBefore);
});

test("attachment downloads report absent rows and missing stored objects", async () => {
  const cookie = await sessionCookie(attachmentOwnerId);
  const absent = await api.inject({
    method: "GET",
    url: `/v1/attachments/${absentAttachmentId}/download`,
    headers: { cookie },
  });
  assert.equal(absent.statusCode, 404);
  assert.equal(absent.json().title, "Attachment not found");

  const missingObject = await api.inject({
    method: "GET",
    url: `/v1/attachments/${missingObjectAttachmentId}/download`,
    headers: { cookie },
  });
  assert.equal(missingObject.statusCode, 404);
  assert.equal(missingObject.json().title, "Stored attachment not found");
});

test("attachment ETags revalidate after authorization without reading storage", async () => {
  const readsBefore = attachmentObjectReadCount;
  const response = await api.inject({
    method: "GET",
    url: `/v1/attachments/${attachmentId}/download`,
    headers: {
      cookie: await sessionCookie(attachmentOwnerId),
      "if-none-match": `"${attachmentChecksum}"`,
    },
  });

  assert.equal(response.statusCode, 304);
  assert.equal(response.headers.etag, `"${attachmentChecksum}"`);
  assert.equal(attachmentObjectReadCount, readsBefore);
});

test("unknown routes use the API problem contract", async () => {
  const response = await api.inject({ method: "GET", url: "/not-a-route" });
  const problem = response.json();

  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["content-type"], "application/problem+json; charset=utf-8");
  assert.equal(problem.type, "about:blank");
  assert.equal(problem.title, "Route not found");
  assert.equal(problem.status, 404);
  assert.equal(problem.requestId, response.headers["x-request-id"]);
});

test("webhooks use their raw-body route before JSON parsing", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/webhooks/openai",
    headers: { "content-type": "application/json" },
    payload: Buffer.from("not-json"),
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().title, "OpenAI webhook is not configured");
});

test("Google Pub/Sub push reports missing authentication configuration", async () => {
  const response = await api.inject({
    method: "POST",
    url: "/v1/webhooks/google-pubsub",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(
    response.json().title,
    "Google Pub/Sub push authentication is not configured",
  );
});

test("Google Pub/Sub authenticates before parsing its push body", async () => {
  process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE = "http://localhost:3000/v1/webhooks/google-pubsub";
  process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL = "gmail-push@example.com";
  process.env.GOOGLE_PUBSUB_SUBSCRIPTION =
    "projects/invook/subscriptions/gmail-mailbox-changes";
  try {
    const response = await api.inject({
      method: "POST",
      url: "/v1/webhooks/google-pubsub",
      headers: { "content-type": "application/json" },
      payload: "{",
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.json().title, "Google Pub/Sub authentication required");
  } finally {
    delete process.env.GOOGLE_PUBSUB_PUSH_AUDIENCE;
    delete process.env.GOOGLE_PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PUBSUB_SUBSCRIPTION;
  }
});

test("Google Pub/Sub preserves numeric Gmail history IDs exactly", () => {
  const data = Buffer.from(
    '{"emailAddress":"mailbox@example.com","historyId":18446744073709551615}',
    "utf8",
  ).toString("base64");

  assert.deepEqual(parseGmailNotification(data), {
    emailAddress: "mailbox@example.com",
    historyId: "18446744073709551615",
  });
});

test("mailbox change events require an authenticated session", async () => {
  const response = await api.inject({ method: "GET", url: "/v1/mailbox/events" });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("account sync progress events require an authenticated session", async () => {
  const response = await api.inject({
    method: "GET",
    url: "/v1/account-sync/events",
  });

  assert.equal(response.statusCode, 401);
  assert.equal(response.json().title, "Authentication required");
});

test("Gmail provider writes require an authenticated session", async () => {
  const requests = [
    { method: "POST", url: "/v1/gmail/messages/not-a-uuid/actions" },
    { method: "PUT", url: "/v1/gmail/threads/not-a-uuid/read-state" },
    { method: "PUT", url: "/v1/gmail/drafts/not-a-uuid" },
    { method: "DELETE", url: "/v1/gmail/drafts/not-a-uuid" },
    { method: "POST", url: "/v1/gmail/compose-drafts" },
    { method: "PUT", url: "/v1/gmail/compose-drafts/provider-draft" },
    {
      method: "POST",
      url: "/v1/gmail/compose-drafts/provider-draft/send",
    },
    { method: "POST", url: "/v1/drafts/not-a-uuid/save-to-gmail" },
  ] as const;

  for (const request of requests) {
    const response = await api.inject(request);
    assert.equal(response.statusCode, 401, `${request.method} ${request.url}`);
    assert.equal(response.json().title, "Authentication required");
  }
});

test("obsolete Gmail label routes and Invook label deletion are absent", async () => {
  const requests = [
    { method: "POST", url: "/v1/gmail/labels" },
    {
      method: "PATCH",
      url: "/v1/gmail/labels/00000000-0000-4000-8000-000000000000",
    },
    {
      method: "DELETE",
      url: "/v1/gmail/labels/00000000-0000-4000-8000-000000000000",
    },
    {
      method: "PATCH",
      url: "/v1/gmail/messages/00000000-0000-4000-8000-000000000000/labels",
    },
    {
      method: "PATCH",
      url: "/v1/gmail/threads/00000000-0000-4000-8000-000000000000/labels",
    },
    {
      method: "DELETE",
      url: "/v1/labels/00000000-0000-4000-8000-000000000000",
    },
  ] as const;

  for (const request of requests) {
    const response = await api.inject(request);
    assert.equal(response.statusCode, 404, `${request.method} ${request.url}`);
  }
});

test("plain-text Gmail replies preserve threading headers and prevent header injection", () => {
  const raw = composePlainTextGmailReply({
    accountEmail: "sender@example.com",
    subject: "Quarterly update\r\nBcc: hidden@example.com",
    currentText: "First line\nSecond line",
    replyTarget: {
      sender: { raw: "Recipient <recipient@example.com>", email: "recipient@example.com" },
      headerLines: [
        {
          key: "reply-to",
          line: "Reply-To: replies@example.com\r\nBcc: hidden@example.com",
        },
        { key: "message-id", line: "Message-ID: <message@example.com>" },
        { key: "references", line: "References: <parent@example.com>" },
      ],
    },
  });

  assert.ok(raw);
  const message = raw.toString("utf8");
  assert.match(message, /^From: sender@example\.com\r\nTo: replies@example\.com Bcc: hidden@example\.com\r\n/);
  assert.match(message, /\r\nIn-Reply-To: <message@example\.com>\r\n/);
  assert.match(
    message,
    /\r\nReferences: <parent@example\.com> <message@example\.com>\r\n/,
  );
  assert.match(message, /\r\n\r\nFirst line\r\nSecond line$/);
  assert.doesNotMatch(message, /\r\nBcc:/);
});
