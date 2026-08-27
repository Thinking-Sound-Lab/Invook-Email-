import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import axios, { type AxiosRequestConfig } from "axios";

import {
  GmailApiError,
  GMAIL_MESSAGE_LIST_MAX_RESULTS,
  GMAIL_THREAD_LIST_MAX_RESULTS,
  getGmailAttachment,
  getGmailDraft,
  getGmailMessage,
  getGmailMessageState,
  getGmailThread,
  gmailHistoryChanges,
  isGoogleReauthenticationRequired,
  listGmailDrafts,
  listGmailMessages,
  listGmailThreads,
  modifyGmailMessageLabels,
  modifyGmailThreadLabels,
  sendGmailDraft,
} from "./client";

const originalAxiosRequest = axios.request;
const requests: AxiosRequestConfig[] = [];
let responseData: unknown;

before(() => {
  axios.request = (async (configuration: AxiosRequestConfig) => {
    requests.push(configuration);
    return { data: responseData };
  }) as typeof axios.request;
});

beforeEach(() => {
  requests.length = 0;
  responseData = { messages: [], raw: "cmF3" };
});

after(() => {
  axios.request = originalAxiosRequest;
});

test("complete Gmail message pages use the provider maximum with Spam and Trash", async () => {
  await listGmailMessages("access-token", { pageToken: "next-page" });

  assert.equal(GMAIL_MESSAGE_LIST_MAX_RESULTS, 500);
  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(request.baseURL, "https://gmail.googleapis.com/gmail/v1");
  assert.equal(url.pathname, "/users/me/messages");
  assert.equal(url.searchParams.get("includeSpamTrash"), "true");
  assert.equal(url.searchParams.get("maxResults"), "500");
  assert.equal(url.searchParams.get("pageToken"), "next-page");
});

test("incremental Gmail messages are fetched as parsed full payloads", async () => {
  responseData = {
    id: "message/with spaces",
    threadId: "thread-id",
    payload: { mimeType: "text/plain", body: { data: "dGVzdA" } },
    labelIds: ["IMPORTANT", "INBOX", "Label_7", "CATEGORY_PROMOTIONS"],
  };
  const message = await getGmailMessage(
    "access-token",
    "message/with spaces",
  );

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(request.baseURL, "https://gmail.googleapis.com/gmail/v1");
  assert.equal(url.pathname, "/users/me/messages/message%2Fwith%20spaces");
  assert.equal(url.searchParams.get("format"), "full");
  assert.deepEqual(message.labelIds, ["IMPORTANT", "INBOX"]);
});

test("initial sync lists threads at Gmail's maximum and fetches each as full", async () => {
  responseData = { threads: [{ id: "thread-id" }] };
  await listGmailThreads("access-token", { pageToken: "next-page" });

  assert.equal(GMAIL_THREAD_LIST_MAX_RESULTS, 500);
  const listRequest = requests[0];
  assert.ok(listRequest);
  const listUrl = new URL(listRequest.url ?? "", listRequest.baseURL);
  assert.equal(listUrl.pathname, "/users/me/threads");
  assert.equal(listUrl.searchParams.get("includeSpamTrash"), "true");
  assert.equal(listUrl.searchParams.get("maxResults"), "500");
  assert.equal(listUrl.searchParams.get("pageToken"), "next-page");

  responseData = {
    id: "thread/with spaces",
    messages: [
      {
        id: "message-id",
        threadId: "thread/with spaces",
        labelIds: ["INBOX", "Label_7"],
        payload: { mimeType: "text/plain", body: { data: "dGVzdA" } },
      },
    ],
  };
  const thread = await getGmailThread("access-token", "thread/with spaces");
  const getRequest = requests[1];
  assert.ok(getRequest);
  const getUrl = new URL(getRequest.url ?? "", getRequest.baseURL);
  assert.equal(getUrl.pathname, "/users/me/threads/thread%2Fwith%20spaces");
  assert.equal(getUrl.searchParams.get("format"), "full");
  assert.deepEqual(thread.messages[0]?.labelIds, ["INBOX"]);
});

test("external full-format parts use Gmail's attachment endpoint", async () => {
  responseData = { size: 4, data: "dGVzdA" };
  assert.deepEqual(
    await getGmailAttachment("access-token", "message/id", "attachment/id"),
    responseData,
  );

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(
    url.pathname,
    "/users/me/messages/message%2Fid/attachments/attachment%2Fid",
  );
});

test("label-only history reads minimal state without downloading raw MIME", async () => {
  responseData = {
    id: "label-only-message",
    threadId: "thread-id",
    labelIds: ["UNREAD", "IMPORTANT", "Label_9"],
  };
  const message = await getGmailMessageState(
    "access-token",
    "label-only-message",
  );

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(url.pathname, "/users/me/messages/label-only-message");
  assert.equal(url.searchParams.get("format"), "minimal");
  assert.deepEqual(message.labelIds, ["UNREAD", "IMPORTANT"]);
});

test("draft and provider-write responses discard opaque Gmail label IDs", async () => {
  responseData = {
    id: "draft-id",
    message: {
      id: "draft-message",
      threadId: "thread-id",
      raw: "cmF3",
      labelIds: ["DRAFT", "IMPORTANT", "Label_9", "CATEGORY_UPDATES"],
    },
  };
  const draft = await getGmailDraft("access-token", "draft-id");
  assert.deepEqual(draft.message.labelIds, ["DRAFT", "IMPORTANT"]);

  responseData = {
    id: "message-id",
    threadId: "thread-id",
    labelIds: ["STARRED", "Label_7"],
  };
  const modified = await modifyGmailMessageLabels(
    "access-token",
    "message-id",
    { addLabelIds: ["STARRED"] },
  );
  assert.deepEqual(modified.labelIds, ["STARRED"]);
});

test("thread label writes use Gmail's single thread mutation endpoint", async () => {
  await modifyGmailThreadLabels(
    "access-token",
    "thread/with spaces",
    { removeLabelIds: ["UNREAD"] },
  );

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(url.pathname, "/users/me/threads/thread%2Fwith%20spaces/modify");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.data, { removeLabelIds: ["UNREAD"] });
});

test("history mapping retains only recognized Gmail system labels", () => {
  assert.deepEqual(
    gmailHistoryChanges({
      id: "history-id",
      labelsAdded: [
        {
          message: {
            id: "message-id",
            threadId: "thread-id",
            labelIds: [
              "IMPORTANT",
              "INBOX",
              "Label_7",
              "CATEGORY_PROMOTIONS",
            ],
          },
          labelIds: ["IMPORTANT", "Label_7"],
        },
      ],
    }),
    [
      {
        messageId: "message-id",
        action: "labels",
        providerLabelIds: ["IMPORTANT", "INBOX"],
        isDraftRelated: false,
      },
    ],
  );
});

test("a rejected Google refresh token requires immediate reauthentication", () => {
  const error = new GmailApiError(
    "Google token refresh failed with status 400.",
    400,
    "redacted",
    {
      path: "https://oauth2.googleapis.com/token",
      code: "invalid_grant",
    },
  );

  assert.equal(isGoogleReauthenticationRequired(error), true);
});

test("a Google authentication 401 requires reauthentication", () => {
  const error = new GmailApiError(
    "Google token refresh failed with status 401.",
    401,
    "redacted",
    { path: "https://oauth2.googleapis.com/token" },
  );

  assert.equal(isGoogleReauthenticationRequired(error), true);
});

test("a transient Google provider failure remains retryable", () => {
  const error = new GmailApiError(
    "Google token refresh failed with status 503.",
    503,
    "redacted",
    { path: "https://oauth2.googleapis.com/token" },
  );

  assert.equal(isGoogleReauthenticationRequired(error), false);
});

test("Gmail draft listing forwards an exact provider search query", async () => {
  await listGmailDrafts("access-token", {
    maxResults: 10,
    query: "rfc822msgid:invook-compose@example.invalid",
  });

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(url.pathname, "/users/me/drafts");
  assert.equal(
    url.searchParams.get("q"),
    "rfc822msgid:invook-compose@example.invalid",
  );
});

test("sending uses Gmail's existing-draft endpoint and provider draft identity", async () => {
  await sendGmailDraft("access-token", "provider-draft");

  const request = requests[0];
  assert.ok(request);
  const url = new URL(request.url ?? "", request.baseURL);
  assert.equal(url.pathname, "/users/me/drafts/send");
  assert.equal(request.method, "POST");
  assert.deepEqual(request.data, { id: "provider-draft" });
});
