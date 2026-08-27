"use client";

import {
  Brain02Icon,
  CreditCardIcon,
  Settings01Icon,
  TagsIcon,
  UserAccountIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  MailboxAccount,
  MailboxSettings,
} from "@invook/contracts";
import axios from "axios";
import { useCallback, useEffect, useRef, useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useAccountSyncStore } from "@/stores/account-sync/store";

import { LabelSettings } from "./label-settings";
import { MemorySettings } from "./memory-settings";

const settingsSections = [
  { value: "account", label: "Account", icon: UserAccountIcon },
  { value: "memory", label: "Memory", icon: Brain02Icon },
  { value: "labels", label: "Labels", icon: TagsIcon },
  { value: "billing", label: "Billing", icon: CreditCardIcon },
] as const;

interface AccountSettingsProps {
  account: MailboxAccount;
  aiConfigured: boolean;
}

function AccountSettings({ account, aiConfigured }: AccountSettingsProps) {
  const replicaStatus = account.replica.state.replaceAll("_", " ");

  return (
    <section className="mx-auto w-full max-w-2xl px-6 py-8 sm:px-10 sm:py-10">
      <h2 className="text-xl font-semibold tracking-[-0.03em]">Account</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        Manage this Gmail mailbox separately from your Invook sign-in session.
      </p>

      <div className="mt-7 rounded-xl bg-card/65 p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-sm font-semibold">
            {account.email.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{account.email}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Google Gmail</p>
          </div>
        </div>

        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg bg-background/55 px-4 py-3">
            <dt className="text-xs text-muted-foreground">Connection</dt>
            <dd className="mt-1 font-medium capitalize">{account.status}</dd>
          </div>
          <div className="rounded-lg bg-background/55 px-4 py-3">
            <dt className="text-xs text-muted-foreground">Mailbox replica</dt>
            <dd className="mt-1 font-medium capitalize">{replicaStatus}</dd>
          </div>
          <div className="rounded-lg bg-background/55 px-4 py-3 sm:col-span-2">
            <dt className="text-xs text-muted-foreground">AI features</dt>
            <dd className="mt-1 font-medium">
              {aiConfigured ? "Configured" : "Setup needed"}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {account.status === "reconnect_required" ? (
          <Button asChild>
            <a
              href={`/v1/connections/gmail/start?accountId=${encodeURIComponent(account.id)}`}
            >
              Reconnect Gmail
            </a>
          </Button>
        ) : null}
        <Button asChild variant="outline">
          <a href="/v1/connections/gmail/start">Connect another Gmail account</a>
        </Button>
        <SignOutButton />
      </div>
    </section>
  );
}

function BillingSettings() {
  return (
    <section className="mx-auto w-full max-w-2xl px-6 py-8 sm:px-10 sm:py-10">
      <h2 className="text-xl font-semibold tracking-[-0.03em]">Billing</h2>
      <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
        Review the billing state attached to this Invook installation.
      </p>

      <div className="mt-7 rounded-xl bg-card/65 px-6 py-10 text-center">
        <span className="mx-auto grid size-10 place-items-center rounded-xl bg-secondary text-muted-foreground">
          <HugeiconsIcon icon={CreditCardIcon} size={18} />
        </span>
        <p className="mt-4 text-sm font-semibold">Billing details are unavailable</p>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
          This build does not expose a billing provider or plan status yet.
        </p>
      </div>
    </section>
  );
}

export interface SettingsDialogProps {
  accounts: MailboxAccount[];
  selectedAccountId: string | null;
  aiConfigured: boolean;
  triggerClassName?: string;
}

export function SettingsDialog({
  accounts,
  selectedAccountId,
  aiConfigured,
  triggerClassName,
}: SettingsDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [settingsAccountId, setSettingsAccountId] = useState(
    selectedAccountId ?? accounts[0]?.id ?? "",
  );
  const settingsAccountIdRef = useRef(settingsAccountId);
  const account =
    accounts.find((candidate) => candidate.id === settingsAccountId) ??
    accounts[0];
  const [settings, setSettings] = useState<MailboxSettings | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "available" | "error">(
    "idle",
  );
  const liveMemoryState = useAccountSyncStore(
    (state) => state.progress?.memory,
  );
  const loadSettings = useCallback(async (
    accountId = settingsAccountIdRef.current,
  ): Promise<void> => {
    setLoadState("loading");
    try {
      const response = await axios.get<MailboxSettings>("/v1/mailbox/settings", {
        params: { account: accountId },
      });
      if (settingsAccountIdRef.current !== accountId) return;
      setSettings(response.data);
      setLoadState("available");
    } catch {
      if (settingsAccountIdRef.current !== accountId) return;
      setSettings(null);
      setLoadState("error");
    }
  }, []);

  const handleSettingsAccountChange = useCallback((accountId: string): void => {
    settingsAccountIdRef.current = accountId;
    setSettingsAccountId(accountId);
    setSettings(null);
    void loadSettings(accountId);
  }, [loadSettings]);

  const handleOpenChange = useCallback(
    (nextIsOpen: boolean): void => {
      setIsOpen(nextIsOpen);
      if (nextIsOpen && loadState === "idle") void loadSettings();
    },
    [loadSettings, loadState],
  );

  useEffect(() => {
    return useAccountSyncStore.subscribe((state, previousState) => {
      if (
        isOpen &&
        settings &&
        previousState.progress?.memory !== "complete" &&
        state.progress?.memory === "complete"
      ) {
        void loadSettings();
      }
    });
  }, [isOpen, loadSettings, settings]);

  if (!account) return null;

  const settingsUnavailable = (
    <div className="mx-auto max-w-sm px-6 py-16 text-center" role={loadState === "error" ? "alert" : "status"}>
      <p className="text-sm font-medium">
        {loadState === "error" ? "Settings are unavailable" : "Loading settings"}
      </p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {loadState === "error"
          ? "Invook could not read the current mailbox settings."
          : "Invook is reading the current mailbox settings."}
      </p>
      {loadState === "error" ? (
        <Button type="button" variant="ghost" size="sm" className="mt-3" onClick={() => void loadSettings()}>
          Try again
        </Button>
      ) : null}
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            triggerClassName,
            isOpen && "bg-sidebar-accent text-sidebar-foreground",
          )}
        >
          <HugeiconsIcon
            icon={Settings01Icon}
            size={15}
            strokeWidth={1.65}
            className="shrink-0"
          />
          <span className="hidden truncate lg:block">Settings</span>
        </button>
      </DialogTrigger>
      <DialogContent className="block h-[min(720px,calc(100dvh-2rem))] max-w-[min(1040px,calc(100%-2rem))] overflow-hidden bg-background p-0 sm:max-w-[min(1040px,calc(100%-2rem))]">
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Manage your account, Memory, labels, and billing.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          defaultValue="account"
          orientation="vertical"
          className="grid h-full min-h-0 grid-cols-[64px_minmax(0,1fr)] gap-0 sm:grid-cols-[210px_minmax(0,1fr)]"
        >
          <div className="flex h-full min-h-0 flex-col bg-muted/35 px-2 py-3 sm:px-3 sm:py-4">
            <div className="mb-4 hidden px-3 pt-1 text-left sm:block">
              <p className="text-sm font-semibold tracking-[-0.02em] text-foreground">
                Settings
              </p>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {account.email}
              </p>
            </div>
            {accounts.length > 1 ? (
              <div className="mb-4 hidden space-y-1 sm:block" aria-label="Settings account">
                {accounts.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => handleSettingsAccountChange(candidate.id)}
                    className={cn(
                      "w-full truncate rounded-md px-3 py-2 text-left text-[11px] text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground",
                      candidate.id === account.id && "bg-background/80 font-medium text-foreground",
                    )}
                  >
                    {candidate.email}
                  </button>
                ))}
              </div>
            ) : null}
            <TabsList
              variant="line"
              aria-label="Settings sections"
              className="w-full items-stretch justify-start gap-1 rounded-none p-0"
            >
              {settingsSections.map((section) => (
                <TabsTrigger
                  key={section.value}
                  value={section.value}
                  className="h-9 w-full flex-none justify-center gap-2.5 px-2 text-[13px] after:hidden data-active:bg-background/80 sm:justify-start sm:px-3"
                  aria-label={section.label}
                >
                  <HugeiconsIcon icon={section.icon} size={15} />
                  <span className="hidden sm:inline">{section.label}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="account" className="min-h-0 overflow-y-auto">
            <AccountSettings account={account} aiConfigured={aiConfigured} />
          </TabsContent>
          <TabsContent value="memory" className="min-h-0 overflow-y-auto">
            {settings ? (
              <MemorySettings
                memories={settings.memories}
                accountId={account.id}
                syncState={
                  account.id === selectedAccountId
                    ? liveMemoryState ?? account.syncState.memory
                    : account.syncState.memory
                }
                aiConfigured={aiConfigured}
                onChanged={loadSettings}
              />
            ) : settingsUnavailable}
          </TabsContent>
          <TabsContent value="labels" className="min-h-0 overflow-y-auto">
            {settings ? (
              <LabelSettings
                accountId={account.id}
                invookLabels={settings.invookLabels}
                onChanged={loadSettings}
              />
            ) : settingsUnavailable}
          </TabsContent>
          <TabsContent value="billing" className="min-h-0 overflow-y-auto">
            <BillingSettings />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
