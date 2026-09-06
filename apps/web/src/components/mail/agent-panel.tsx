"use client";

import { useChat } from "@ai-sdk/react";
import {
  ArrowUpRight01Icon,
  BotIcon,
  PencilEdit01Icon,
  Search02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { useMailboxStore } from "@/stores/mailbox/store";

import { formatMailText } from "./mail-format";
import { useMailShell } from "./mail-shell-provider";
type MailAgentUIMessage = UIMessage;

export interface AgentPanelProps {
  accountSelection: string;
  openThreadId?: string;
}

export function AgentPanel({
  accountSelection,
  openThreadId,
}: AgentPanelProps) {
  const { aiConfigured } = useMailShell();
  const openThreadSubject = useMailboxStore((state) =>
    openThreadId ? state.threadsById[openThreadId]?.subject : undefined,
  );
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/v1/agent",
        body: {
          account: accountSelection,
          ...(openThreadId ? { currentThreadId: openThreadId } : {}),
        },
      }),
    [accountSelection, openThreadId],
  );
  const {
    messages,
    sendMessage,
    status,
    error,
    setMessages,
  } = useChat<MailAgentUIMessage>({ transport });
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const suggestions = openThreadId
    ? [
        { label: "Summarize this thread", icon: BotIcon },
        { label: "Draft a reply to this thread", icon: PencilEdit01Icon },
        { label: "Find a related message", icon: Search02Icon },
      ]
    : [
        { label: "Find my resident certificate", icon: Search02Icon },
        { label: "Find a message or decision", icon: Search02Icon },
        { label: "Help me draft a follow-up", icon: PencilEdit01Icon },
      ];

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status]);

  const handleSubmit = (text: string) => {
    const value = text.trim();
    if (!value || !aiConfigured || busy) return;
    void sendMessage({ text: value });
    setInput("");
  };

  return (
    <aside
      className="hidden min-h-0 flex-col bg-card xl:flex"
      aria-label="Invook agent"
    >
      <header className="flex h-15 shrink-0 items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <HugeiconsIcon
            icon={BotIcon}
            size={16}
            strokeWidth={1.7}
            className="shrink-0 text-muted-foreground"
          />
          <h2 className="truncate text-[15px] font-semibold">Invook</h2>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          disabled={messages.length === 0 || busy}
          onClick={() => setMessages([])}
          aria-label="Start a new chat"
          className="text-muted-foreground"
        >
          <HugeiconsIcon icon={PencilEdit01Icon} size={15} />
        </Button>
      </header>

      {openThreadSubject ? (
        <div className="mx-3">
          <div className="rounded-lg bg-background/45 px-3 py-2.5">
            <p className="text-xs font-medium text-muted-foreground">Current thread</p>
            <p className="mt-1 truncate text-[13px] text-foreground/82">
              {formatMailText(openThreadSubject)}
            </p>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-end pb-2">
            <div className="space-y-1">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.label}
                  type="button"
                  disabled={!aiConfigured || busy}
                  onClick={() => handleSubmit(suggestion.label)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2.5 text-left text-[13px] text-foreground/76 transition-colors hover:bg-accent disabled:opacity-45"
                >
                  <HugeiconsIcon
                    icon={suggestion.icon}
                    size={14}
                    strokeWidth={1.65}
                    className="text-muted-foreground"
                  />
                  <span>{suggestion.label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "text-[13px] leading-5",
                  message.role === "user"
                    ? "ml-8 rounded-xl bg-primary px-3 py-2 text-primary-foreground"
                    : "mr-2 text-foreground/82",
                )}
              >
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    return (
                      <p key={index} className="whitespace-pre-wrap">
                        {part.text}
                      </p>
                    );
                  }
                  if (part.type.startsWith("tool-")) {
                    return (
                      <div
                        key={index}
                        className="my-1.5 flex items-center gap-2 rounded-md bg-secondary/55 px-2.5 py-2 text-xs text-muted-foreground"
                      >
                        <HugeiconsIcon icon={SparklesIcon} size={12} />
                        Working with mailbox data
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            ))}
            {busy ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <HugeiconsIcon icon={SparklesIcon} size={12} />
                {status === "submitted" ? "Thinking" : "Working"}
              </div>
            ) : null}
            {error ? (
              <p className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                Invook could not complete that request.
              </p>
            ) : null}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <form
        className="shrink-0 p-3 pt-0"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit(input);
        }}
      >
        <div className="rounded-xl bg-background/72 p-2 shadow-xl shadow-black/15">
          <Textarea
            disabled={!aiConfigured || busy}
            aria-label="Message Invook agent"
            placeholder={
              aiConfigured
                ? "Ask Invook to find or draft mail"
                : "Connect an AI model to chat"
            }
            className="min-h-20 resize-none border-0 bg-transparent px-2 py-1.5 text-sm shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <div className="flex justify-end pt-1">
            <Button
              size="icon-sm"
              type="submit"
              disabled={!input.trim() || !aiConfigured || busy}
              aria-label="Send message"
              className="rounded-full"
            >
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={14} />
            </Button>
          </div>
        </div>
      </form>
    </aside>
  );
}
