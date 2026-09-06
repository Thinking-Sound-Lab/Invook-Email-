"use client";

import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/http-error";
import { setGmailMessageStar } from "@/lib/api/gmail-message-actions";
import { useMailboxStore } from "@/stores/mailbox/store";
import { cn } from "@/lib/utils";

export interface MessageStarButtonProps {
  messageId: string;
  threadId: string;
  isStarred: boolean;
}

/**
 * A predicted star and the stored value it was predicted against. Holding both
 * lets the prediction expire by derivation once the server render catches up,
 * so stored state stays authoritative without an effect resetting local state.
 */
interface StarPrediction {
  storedIsStarred: boolean;
  isStarred: boolean;
}

export function MessageStarButton({
  messageId,
  threadId,
  isStarred,
}: MessageStarButtonProps) {
  const patchThread = useMailboxStore((state) => state.patchThread);
  const [prediction, setPrediction] = useState<StarPrediction | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentIsStarred =
    prediction && prediction.storedIsStarred === isStarred
      ? prediction.isStarred
      : isStarred;
  const label = currentIsStarred
    ? "Remove star from message"
    : "Star message";

  async function handleStar(): Promise<void> {
    if (isSubmitting) return;
    const nextIsStarred = !currentIsStarred;
    setIsSubmitting(true);
    setError(null);
    setPrediction({ storedIsStarred: isStarred, isStarred: nextIsStarred });
    // The cached row reflects the change immediately; the mailbox change event
    // that follows the Gmail write reconciles it against stored state.
    patchThread({ threadId, patch: { isStarred: nextIsStarred } });
    try {
      await setGmailMessageStar({ messageId, isStarred: nextIsStarred });
    } catch (cause) {
      setPrediction(null);
      patchThread({ threadId, patch: { isStarred: currentIsStarred } });
      setError(apiErrorMessage(cause, "Invook could not update this star."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={currentIsStarred}
        aria-busy={isSubmitting}
        onClick={() => void handleStar()}
        className={cn(
          "text-muted-foreground",
          currentIsStarred && "text-warning hover:text-warning",
        )}
      >
        <HugeiconsIcon
          icon={StarIcon}
          size={16}
          fill={currentIsStarred ? "currentColor" : "none"}
        />
      </Button>
      {error ? (
        <p
          role="alert"
          className="absolute right-0 top-9 z-40 w-56 rounded-lg bg-popover px-3 py-2 text-xs leading-5 text-destructive shadow-xl ring-1 ring-border/55"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
