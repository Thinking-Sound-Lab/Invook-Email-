import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";

import type { MailboxShell } from "@invook/contracts";
import axios, { type AxiosRequestConfig } from "axios";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { validate as validateUuid } from "uuid";

const browserWindow = new Window({ url: "http://localhost" });
for (const [name, value] of Object.entries({
  window: browserWindow,
  self: browserWindow,
  document: browserWindow.document,
  navigator: browserWindow.navigator,
  HTMLElement: browserWindow.HTMLElement,
  HTMLFormElement: browserWindow.HTMLFormElement,
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

const shell: MailboxShell = {
  aiConfigured: true,
  user: { name: "Owner", email: "owner@example.com", image: null },
  accounts: [
    {
      id: "account-1",
      email: "owner@example.com",
      image: null,
      status: "connected",
      syncState: { mailSync: "complete", memory: "complete" },
      lastSyncedAt: "2026-09-01T00:00:00.000Z",
      replica: { state: "ready", readyAt: "2026-09-01T00:00:00.000Z" },
    },
  ],
  accountLabels: [],
};
let root: Root | null = null;
const originalAdapter = axios.defaults.adapter;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function renderComposeSurface(): Promise<void> {
  const [
    { createRoot },
    { AppRouterContext },
    { SearchParamsContext },
    { MailShellProvider },
    { ComposeSurface },
  ] = await Promise.all([
    import("react-dom/client"),
    import("next/dist/shared/lib/app-router-context.shared-runtime"),
    import("next/dist/shared/lib/hooks-client-context.shared-runtime"),
    import("./mail-shell-provider"),
    import("./compose-surface"),
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
        <SearchParamsContext.Provider
          value={new URLSearchParams("account=account-1")}
        >
          <MailShellProvider shell={shell}>
            <ComposeSurface />
          </MailShellProvider>
        </SearchParamsContext.Provider>
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

test("the sidebar compose route renders the reference workspace controls", async () => {
  await renderComposeSurface();

  assert.ok(document.querySelector('[aria-label="New message composer"]'));
  assert.equal(
    document
      .querySelector<HTMLAnchorElement>('a[aria-label="Close composer"]')
      ?.getAttribute("href"),
    "/mail?account=account-1",
  );
  assert.equal(document.querySelector("#compose-cc-recipients"), null);
  assert.equal(button("Send").disabled, false);
  assert.equal(button("Send later").disabled, true);
  assert.equal(button("Remind me").disabled, true);
  assert.equal(button("Attachments unavailable").disabled, true);
  assert.deepEqual(
    [
      ...(document
        .querySelector('footer[aria-label="Compose actions"]')
        ?.querySelectorAll("button") ?? []),
    ].map((action) => action.textContent?.trim()),
    ["Send", "Send later", "Remind me", ""],
  );

  await click("Cc/Bcc");
  assert.ok(document.querySelector("#compose-cc-recipients"));
  assert.ok(document.querySelector("#compose-bcc-recipients"));
});

test("the composer card is bounded by its pane and keeps its actions reachable", async () => {
  await renderComposeSurface();

  const card = document.querySelector<HTMLElement>(
    'form[aria-label="New message composer"] > div',
  );
  const messageRegion = document.querySelector<HTMLElement>(
    '[role="region"][aria-label="Message fields and body"]',
  );
  const actionRail = document.querySelector<HTMLElement>(
    'footer[aria-label="Compose actions"]',
  );
  assert.ok(card);
  assert.ok(messageRegion);
  assert.ok(actionRail);
  // The card grows with its content up to the pane instead of always filling it.
  assert.match(card.className, /\bmax-h-full\b/);
  assert.doesNotMatch(card.className, /\bflex-1\b/);
  assert.match(messageRegion.className, /\boverflow-y-auto\b/);
  assert.match(actionRail.className, /\bshrink-0\b/);
  assert.equal(messageRegion.contains(actionRail), false);
});

test("sending the redesigned composer saves and sends one Gmail draft", async () => {
  const requests: AxiosRequestConfig[] = [];
  axios.defaults.adapter = async (config) => {
    requests.push(config);
    return {
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "provider-message",
              providerThreadId: "provider-thread",
            },
          }
        : {
            draft: {
              providerDraftId: "provider-draft",
              providerMessageId: "provider-message",
              providerThreadId: "provider-thread",
            },
          },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  await renderComposeSurface();
  await click("Cc/Bcc");
  await enter("#compose-recipients", "recipient@example.com");
  await enter("#compose-cc-recipients", "copy@example.com");
  await enter("#compose-bcc-recipients", "private@example.com");
  await enter("#compose-subject", "Project update");
  await enter("#compose-body", "The work is ready for review.");

  await click("Send");

  // Send is a single click: the sidebar composer never interposes a prompt.
  assert.equal(document.querySelector('[role="alertdialog"]'), null);
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "post /v1/gmail/compose-drafts",
      "post /v1/gmail/compose-drafts/provider-draft/send",
    ],
  );
  const payload: unknown = JSON.parse(String(requests[0]?.data));
  assert.ok(isRecord(payload));
  assert.equal(typeof payload.idempotencyKey, "string");
  assert.ok(validateUuid(payload.idempotencyKey));
  assert.deepEqual({ ...payload, idempotencyKey: "save-key" }, {
    accountId: "account-1",
    idempotencyKey: "save-key",
    recipients: ["recipient@example.com"],
    ccRecipients: ["copy@example.com"],
    bccRecipients: ["private@example.com"],
    subject: "Project update",
    body: "The work is ready for review.",
  });
  const sendPayload: unknown = JSON.parse(String(requests[1]?.data));
  assert.ok(isRecord(sendPayload));
  assert.ok(validateUuid(String(sendPayload.idempotencyKey)));
  assert.notEqual(sendPayload.idempotencyKey, payload.idempotencyKey);
  assert.equal(sendPayload.accountId, "account-1");
  assert.equal(button("Sent with Gmail").disabled, true);
});

test("an unresolved send retries the same draft and idempotency keys", async () => {
  const requests: AxiosRequestConfig[] = [];
  axios.defaults.adapter = async (config) => {
    requests.push(config);
    if (config.url?.endsWith("/send") && requests.length === 2) {
      throw new Error("Gmail is unavailable.");
    }
    return {
      data: config.url?.endsWith("/send")
        ? {
            message: {
              providerMessageId: "provider-message",
              providerThreadId: "provider-thread",
            },
          }
        : {
            draft: {
              providerDraftId: "provider-draft",
              providerMessageId: "provider-message",
              providerThreadId: "provider-thread",
            },
          },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    };
  };
  await renderComposeSurface();
  await enter("#compose-recipients", "recipient@example.com");
  await enter("#compose-subject", "Project update");
  await enter("#compose-body", "The work is ready for review.");

  await click("Send");
  assert.equal(
    document.querySelector<HTMLInputElement>("#compose-recipients")?.disabled,
    true,
  );

  await click("Retry send");

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.url}`),
    [
      "post /v1/gmail/compose-drafts",
      "post /v1/gmail/compose-drafts/provider-draft/send",
      "post /v1/gmail/compose-drafts/provider-draft/send",
    ],
  );
  assert.equal(requests[1]?.data, requests[2]?.data);
  assert.ok(button("Sent with Gmail"));
});
