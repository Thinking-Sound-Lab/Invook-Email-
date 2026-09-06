import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { after, afterEach, test } from "node:test";

import axios from "axios";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { MailboxShell } from "@invook/contracts";

import type { ThreadComposerProps } from "./thread-composer";

const browserWindow = new Window({ url: "http://localhost" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  HTMLInputElement: browserWindow.HTMLInputElement,
  HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
  Event: browserWindow.Event,
  MouseEvent: browserWindow.MouseEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}
Object.defineProperty(browserWindow, "confirm", {
  value: () => true,
  configurable: true,
});

const shell: MailboxShell = {
  aiConfigured: true,
  user: { name: "Owner", email: "owner@example.com", image: null },
  accounts: [
    {
      id: "account-1",
      email: "owner@example.com",
      image: null,
      status: "connected",
      syncState: { mailSync: "complete" },
      lastSyncedAt: "2026-08-28T00:00:00.000Z",
      replica: { state: "ready", readyAt: "2026-08-28T00:00:00.000Z" },
    },
  ],
  accountLabels: [],
};
const props: ThreadComposerProps = {
  threadId: "thread-1",
  accountId: "account-1",
  accountEmail: "owner@example.com",
  message: {
    id: "message-1",
    direction: "incoming",
    sender: { email: "sender@example.com", raw: "Sender <sender@example.com>" },
    recipients: ["owner@example.com"],
    headers: [],
    subject: "Question",
    bodyText: "Original message",
    sentAt: "2026-08-28T12:00:00.000Z",
    attachmentCount: 0,
  },
};
let root: Root | null = null;
const originalAdapter = axios.defaults.adapter;

/**
 * Composing re-reads the open thread so the reader shows the sent message.
 * That read is asserted on its own; the protocol assertions below stay focused
 * on the compose mutations.
 */
function isThreadRead(config: { method?: string; url?: string }): boolean {
  return (
    (config.method ?? "get").toLowerCase() === "get" &&
    Boolean(config.url?.startsWith("/v1/mailbox/threads/"))
  );
}

const threadReadNotFound = {
  status: 404,
  statusText: "Not Found",
  headers: {},
  data: null,
};

async function renderComposer(
  input: ThreadComposerProps = props,
): Promise<void> {
  const [
    { createRoot },
    { AppRouterContext },
    { MailShellProvider },
    { ThreadComposer },
  ] = await Promise.all([
    import("react-dom/client"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"),
    import("./mail-shell-provider"),
    import("./thread-composer"),
  ]);
  if (!root) {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  const currentRoot = root;
  await act(async () => {
    currentRoot.render(
      <AppRouterContext.Provider
        value={{
          back() {},
          forward() {},
          refresh() {},
          push() {},
          replace() {},
          prefetch() {},
          bfcacheId: "test",
        }}
      >
        <MailShellProvider shell={shell}>
          <ThreadComposer {...input} />
        </MailShellProvider>
      </AppRouterContext.Provider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

async function enter(selector: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  assert.ok(input);
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  const currentRoot = root;
  if (currentRoot) await act(async () => currentRoot.unmount());
  root = null;
  document.body.replaceChildren();
  axios.defaults.adapter = originalAdapter;
});
after(() => browserWindow.close());

test("only the two action chips appear until Reply or Forward is selected", async () => {
  await renderComposer();
  assert.deepEqual(
    [...document.querySelectorAll("button")].map((node) =>
      node.textContent?.trim(),
    ),
    ["Reply", "Forward"],
  );
  assert.equal(document.querySelector("form"), null);
  await click("Reply");
  assert.ok(document.querySelector('[aria-label="Reply composer"]'));
  assert.equal(
    document.querySelector<HTMLInputElement>('input[id$="-to"]')?.value,
    "sender@example.com",
  );
  assert.equal(document.querySelector("textarea")?.value, "");
  assert.equal(button("Send later").disabled, true);
  assert.equal(button("Remind me").disabled, true);
  if (process.env.THREAD_COMPOSER_SNAPSHOT_PATH) {
    await writeFile(
      process.env.THREAD_COMPOSER_SNAPSHOT_PATH,
      document.body.innerHTML,
    );
  }
  await click("Forward");
  assert.ok(document.querySelector('[aria-label="Forward composer"]'));
  assert.equal(
    document.querySelector<HTMLInputElement>('input[id$="-to"]')?.value,
    "",
  );
  assert.equal(document.querySelector("textarea")?.value, "");
  assert.equal(
    document.querySelector('[aria-label="Forwarded message"]'),
    null,
  );
  assert.doesNotMatch(
    document.querySelector("form")?.textContent ?? "",
    /From owner@example\.com/,
  );
  await click("Show quoted text");
  assert.match(
    document.querySelector('[aria-label="Forwarded message"]')?.textContent ??
      "",
    /Original message/,
  );
  assert.ok(button("Hide quoted text"));
  await click("Cc/Bcc");
  for (const field of ["ccRecipients", "bccRecipients"] as const) {
    const input = document.querySelector<HTMLInputElement>(
      `input[id$="-${field}"]`,
    );
    assert.ok(input);
    assert.equal(input.placeholder, "Add recipient");
    assert.equal(
      document.querySelector(`label[for="${input.id}"]`)?.textContent?.trim(),
      field === "ccRecipients" ? "Cc" : "Bcc",
    );
  }
  assert.ok(document.querySelector('label[for$="-subject"]'));
});

test("manual edits survive server refreshes and Send submits the current text once", async () => {
  const requests: Array<{ url: string | undefined; data: unknown }> = [];
  axios.defaults.adapter = async (config) => {
    if (isThreadRead(config)) throw { ...threadReadNotFound, config };
    requests.push({
      url: config.url,
      data:
        typeof config.data === "string" ? JSON.parse(config.data) : config.data,
    });
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "sent-1",
              providerThreadId: "thread-1",
            },
            stepId: "send-step",
          }
        : {
            draft: {
              providerDraftId: "draft-1",
              providerMessageId: "draft-message",
              providerThreadId: "thread-1",
            },
            stepId: "save-step",
          },
    };
  };
  await renderComposer();
  await click("Reply");
  await enter("textarea", "My manual reply");
  await click("Cc/Bcc");
  await enter('input[id$="-ccRecipients"]', "copy@example.com");
  assert.equal(document.querySelector("textarea")?.value, "My manual reply");
  await click("Send");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "/v1/gmail/compose-drafts");
  assert.ok(requests[0]?.data && typeof requests[0].data === "object");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(requests[0].data).filter(
        ([key]) => key !== "idempotencyKey",
      ),
    ),
    {
      accountId: "account-1",
      recipients: ["sender@example.com"],
      ccRecipients: ["copy@example.com"],
      bccRecipients: [],
      subject: "Re: Question",
      body: "My manual reply",
      replyToMessageId: "message-1",
    },
  );
  assert.equal(requests[1]?.url, "/v1/gmail/compose-drafts/draft-1/send");
  assert.equal(document.querySelector("form"), null);
  assert.match(
    document.querySelector('[role="status"]')?.textContent ?? "",
    /Sent with Gmail/,
  );
});

test("send failure retains the editor and retry resolves the same provider draft", async () => {
  let creates = 0;
  const sendRequests: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    if (isThreadRead(config)) throw { ...threadReadNotFound, config };
    if (config.url?.endsWith("/send")) {
      sendRequests.push(config.data);
      if (sendRequests.length === 1) throw new Error("connection lost");
      return {
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: {
          message: {
            providerMessageId: "sent-1",
            providerThreadId: "thread-1",
          },
          stepId: "send-step",
        },
      };
    }
    creates += 1;
    return {
      config,
      status: 201,
      statusText: "Created",
      headers: {},
      data: {
        draft: {
          providerDraftId: "draft-1",
          providerMessageId: "draft-message",
          providerThreadId: "thread-1",
        },
        stepId: "save-step",
      },
    };
  };
  await renderComposer();
  await click("Reply");
  await enter("textarea", "A reply");
  await click("Send");
  assert.ok(document.querySelector('[role="alert"]'));
  assert.equal(document.querySelector("textarea")?.disabled, true);
  assert.equal(button("Forward").disabled, true);
  await click("Retry send");
  assert.equal(creates, 1);
  assert.equal(sendRequests.length, 2);
  assert.equal(sendRequests[0], sendRequests[1]);
  assert.equal(document.querySelector("form"), null);
});

test("Forward cannot send without a recipient and sends without reply threading", async () => {
  const requests: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    if (isThreadRead(config)) throw { ...threadReadNotFound, config };
    requests.push(
      typeof config.data === "string" ? JSON.parse(config.data) : config.data,
    );
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "sent",
              providerThreadId: "new-thread",
            },
            stepId: "send-step",
          }
        : {
            draft: {
              providerDraftId: "forward-draft",
              providerMessageId: "forward-message",
              providerThreadId: "new-thread",
            },
            stepId: "save-step",
          },
    };
  };
  await renderComposer();
  await click("Forward");
  await click("Send");
  assert.equal(requests.length, 0);
  assert.match(
    document.querySelector('[role="alert"]')?.textContent ?? "",
    /recipient/,
  );
  await enter('input[id$="-to"]', "forward@example.com");
  await enter("textarea", "Please see below.");
  await click("Send");
  const request = requests[0];
  assert.ok(request && typeof request === "object");
  assert.equal("replyToMessageId" in request, false);
  assert.deepEqual("recipients" in request && request.recipients, [
    "forward@example.com",
  ]);
  assert.equal(
    "body" in request && typeof request.body === "string" ? request.body : "",
    "Please see below.",
  );
  assert.equal(
    "forwardOfMessageId" in request && request.forwardOfMessageId,
    "message-1",
  );
  assert.equal(requests.length, 2);
});

test("a long collapsed forward sends only its source ID and authored text", async () => {
  const originalText = "Original message line\n".repeat(5_000);
  const requests: unknown[] = [];
  axios.defaults.adapter = async (config) => {
    if (isThreadRead(config)) throw { ...threadReadNotFound, config };
    requests.push(
      typeof config.data === "string" ? JSON.parse(config.data) : config.data,
    );
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "sent",
              providerThreadId: "new-thread",
            },
            stepId: "send-step",
          }
        : {
            draft: {
              providerDraftId: "forward-draft",
              providerMessageId: "forward-message",
              providerThreadId: "new-thread",
            },
            stepId: "save-step",
          },
    };
  };
  assert.ok(props.message);
  await renderComposer({
    ...props,
    message: { ...props.message, bodyText: originalText },
  });
  await click("Forward");
  assert.equal(document.querySelector("textarea")?.value, "");
  assert.equal(
    document.querySelector('[aria-label="Forwarded message"]'),
    null,
  );
  await enter('input[id$="-to"]', "forward@example.com");
  await click("Send");
  assert.equal(requests.length, 2);
  const request = requests[0];
  assert.ok(request && typeof request === "object");
  assert.equal("body" in request && request.body, "");
  assert.equal(
    "forwardOfMessageId" in request && request.forwardOfMessageId,
    "message-1",
  );
  assert.ok(JSON.stringify(request).length < 65_536);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(document.querySelector("form"), null);
});

test("two immediate submit events admit only one send attempt", async () => {
  let sends = 0;
  let creates = 0;
  axios.defaults.adapter = async (config) => {
    if (isThreadRead(config)) throw { ...threadReadNotFound, config };
    if (config.url?.endsWith("/send")) sends += 1;
    else creates += 1;
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "sent",
              providerThreadId: "thread-1",
            },
            stepId: "send-step",
          }
        : {
            draft: {
              providerDraftId: "draft-1",
              providerMessageId: "draft-message",
              providerThreadId: "thread-1",
            },
            stepId: "save-step",
          },
    };
  };
  await renderComposer();
  await click("Reply");
  await enter("textarea", "Reply text");
  const form = document.querySelector("form");
  assert.ok(form);
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  assert.equal(creates, 1);
  assert.equal(sends, 1);
});

test("a sent reply re-reads the open thread instead of refreshing the route", async () => {
  const threadReads: string[] = [];
  axios.defaults.adapter = async (config) => {
    if (isThreadRead(config)) {
      threadReads.push(config.url ?? "");
      throw { ...threadReadNotFound, config };
    }
    return {
      config,
      status: 200,
      statusText: "OK",
      headers: {},
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "sent",
              providerThreadId: "thread-1",
            },
            stepId: "send-step",
          }
        : {
            draft: {
              providerDraftId: "draft-1",
              providerMessageId: "draft-message",
              providerThreadId: "thread-1",
            },
            stepId: "save-step",
          },
    };
  };
  await renderComposer();
  await click("Reply");
  await enter("textarea", "Reply text");
  await click("Send");
  assert.deepEqual(threadReads, ["/v1/mailbox/threads/thread-1"]);
});
