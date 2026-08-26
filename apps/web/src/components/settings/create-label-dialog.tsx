"use client";

import {
  ArrowLeft01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LABEL_PREVIEW_STALE_ERROR } from "@invook/contracts";
import type {
  CreateInvookLabelRequest,
  InvookLabelPreviewResponse,
  LabelHistoryWindowDays,
  PreviewInvookLabelRequest,
} from "@invook/contracts";
import { useState, type FormEvent } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { apiErrorMessage } from "@/lib/http-error";

export interface CreateLabelDialogProps {
  onClose: () => void;
  onCreate: (request: CreateInvookLabelRequest) => Promise<void>;
  onPreview: (
    request: PreviewInvookLabelRequest,
  ) => Promise<InvookLabelPreviewResponse>;
}

const previewDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

function previewDate(sentAt: string): string {
  return previewDateFormatter.format(new Date(sentAt));
}

function parseHistoryWindow(value: string): LabelHistoryWindowDays {
  if (value === "30") return 30;
  if (value === "90") return 90;
  return 7;
}

export function CreateLabelDialog({
  onClose,
  onCreate,
  onPreview,
}: CreateLabelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<InvookLabelPreviewResponse | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isHistoryEnabled, setIsHistoryEnabled] = useState(true);
  const [historyWindowDays, setHistoryWindowDays] =
    useState<LabelHistoryWindowDays>(7);
  const [error, setError] = useState<string | null>(null);

  const canContinue = Boolean(name.trim() && description.trim());

  function resetPreview() {
    setPreview(null);
    setError(null);
  }

  async function handlePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canContinue || isScanning) return;
    setIsScanning(true);
    setError(null);
    try {
      const result = await onPreview({ name, description });
      setPreview(result);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not preview this label."));
    } finally {
      setIsScanning(false);
    }
  }

  async function handleCreate() {
    setIsCreating(true);
    setError(null);
    try {
      await onCreate({
        name,
        description,
        applyToPastDays: isHistoryEnabled ? historyWindowDays : null,
        previewReceiptId:
          isHistoryEnabled && preview?.previewReceiptId
            ? preview.previewReceiptId
            : undefined,
      });
      onClose();
    } catch (cause) {
      const message = apiErrorMessage(
        cause,
        "Invook could not create this label.",
      );
      setError(message);
      if (message === LABEL_PREVIEW_STALE_ERROR) setPreview(null);
      setIsConfirming(false);
      setIsCreating(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && !isCreating && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="h-[min(740px,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-5xl"
        >
          <div className="grid min-h-0 flex-1 overflow-y-auto md:grid-cols-[minmax(320px,0.84fr)_minmax(420px,1.16fr)] md:overflow-hidden">
            <form
              onSubmit={handlePreview}
              className="flex min-h-0 flex-col bg-muted/20 p-5 sm:p-7"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mb-6 w-fit -translate-x-2 text-muted-foreground"
                onClick={onClose}
                disabled={isCreating}
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
                Back to settings
              </Button>

              <DialogHeader>
                <DialogTitle className="text-xl font-semibold tracking-[-0.025em]">
                  Create custom label
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Define a label, preview matching stored email, and choose whether to
                  apply it to recent mail.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-7 space-y-5">
                <div className="space-y-2">
                  <label htmlFor="label-name" className="text-xs font-medium">
                    Label name
                  </label>
                  <Input
                    id="label-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      resetPreview();
                    }}
                    placeholder="Security"
                    autoFocus
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label htmlFor="label-description" className="text-xs font-medium">
                    AI instruction
                  </label>
                  <Textarea
                    id="label-description"
                    value={description}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      resetPreview();
                    }}
                    placeholder="Describe which emails should receive this label…"
                    className="min-h-36 resize-none leading-6"
                    required
                  />
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    Be specific about the sender, topic, or intent that should match.
                  </p>
                </div>
              </div>

              {error ? (
                <p role="alert" className="mt-4 text-xs leading-5 text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="mt-auto pt-6">
                {preview ? (
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => setIsConfirming(true)}
                  >
                    Create label
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={!canContinue || isScanning}
                  >
                    {isScanning ? (
                      <>
                        <span className="animate-spin">
                          <HugeiconsIcon icon={Loading03Icon} size={15} />
                        </span>
                        Scanning stored mail…
                      </>
                    ) : (
                      "Continue"
                    )}
                  </Button>
                )}
              </div>
            </form>

            <section
              className="flex min-h-96 flex-col bg-background p-7 md:min-h-0"
              aria-live="polite"
            >
              <div>
                <h3 className="text-xl font-semibold tracking-[-0.025em]">
                  Sample matching threads
                </h3>
                {preview ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Found {preview.matches.length} matches in your {preview.scannedThreadCount}{" "}
                    most recent Inbox threads.
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Preview up to 100 recent Inbox threads before saving the label.
                  </p>
                )}
              </div>

              {isScanning ? (
                <div className="grid flex-1 place-items-center text-center">
                  <div>
                    <span className="mx-auto block w-fit animate-spin text-primary">
                      <HugeiconsIcon icon={Loading03Icon} size={24} />
                    </span>
                    <p className="mt-3 text-sm font-medium">Scanning stored mail</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Your label definition is being checked against recent messages.
                    </p>
                  </div>
                </div>
              ) : preview ? (
                <ScrollArea className="mt-5 min-h-0 flex-1 pr-3">
                  {preview.matches.length > 0 ? (
                    <div className="space-y-1">
                      {preview.matches.map((match) => (
                        <article
                          key={match.threadId}
                          className="group grid grid-cols-[18px_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/45"
                        >
                          <span className="grid size-4 place-items-center rounded-[4px] bg-primary text-primary-foreground">
                            <HugeiconsIcon icon={Tick02Icon} size={11} strokeWidth={2.4} />
                          </span>
                          <p className="truncate text-xs font-semibold">{match.sender}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {match.subject || "(No subject)"}
                          </p>
                          <time
                            dateTime={match.sentAt}
                            className="text-[11px] text-muted-foreground"
                          >
                            {previewDate(match.sentAt)}
                          </time>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="grid h-full min-h-64 place-items-center text-center">
                      <div>
                        <p className="text-sm font-medium">No sample matches</p>
                        <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                          Refine the instruction, or create the label for future messages.
                        </p>
                      </div>
                    </div>
                  )}
                </ScrollArea>
              ) : (
                <ol className="mt-8 space-y-5 text-sm text-muted-foreground">
                  <li className="flex gap-4">
                    <span className="font-semibold text-foreground">1</span>
                    Name your label.
                  </li>
                  <li className="flex gap-4">
                    <span className="font-semibold text-foreground">2</span>
                    Describe the messages that should receive it.
                  </li>
                  <li className="flex gap-4">
                    <span className="font-semibold text-foreground">3</span>
                    Continue to scan recent stored mail and inspect sample matches.
                  </li>
                </ol>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={isConfirming}
        onOpenChange={(open) => !isCreating && setIsConfirming(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create &ldquo;{name.trim()}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              New messages will be labeled automatically after ingestion analysis.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="flex items-center gap-3 rounded-lg bg-muted/45 px-3 py-2.5">
            <input
              id="apply-to-past-email"
              type="checkbox"
              checked={isHistoryEnabled}
              onChange={(event) => setIsHistoryEnabled(event.target.checked)}
              className="size-4 accent-primary"
              disabled={isCreating}
            />
            <label htmlFor="apply-to-past-email" className="flex-1 text-sm font-medium">
              Also apply to past emails
            </label>
            <select
              aria-label="Past email window"
              value={historyWindowDays}
              onChange={(event) =>
                setHistoryWindowDays(parseHistoryWindow(event.target.value))
              }
              disabled={!isHistoryEnabled || isCreating}
              className="h-8 rounded-md bg-background px-2 text-xs outline-none ring-1 ring-border focus:ring-ring disabled:opacity-45"
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>

          <AlertDialogFooter className="border-0">
            <AlertDialogCancel disabled={isCreating}>Back</AlertDialogCancel>
            <AlertDialogAction
              variant="default"
              disabled={isCreating}
              onClick={(event) => {
                event.preventDefault();
                void handleCreate();
              }}
            >
              {isCreating ? "Creating…" : "Create label"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
