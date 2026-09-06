"use client";

import { Tag01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { InvookLabel, InvookThreadLabel } from "@invook/contracts";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { setThreadLabel } from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";
import { useMailboxStore } from "@/stores/mailbox/store";

/**
 * A predicted label and the stored label it was predicted against. Holding both
 * lets the prediction expire by derivation once the server render catches up,
 * so stored state stays authoritative without an effect resetting local state.
 */
interface LabelPrediction {
  storedLabelId: string | null;
  label: InvookThreadLabel;
}

export interface SmartLabelControlsProps {
  threadId: string;
  label: InvookThreadLabel | null;
  availableLabels: InvookLabel[];
}

export function SmartLabelControls({
  threadId,
  label,
  availableLabels,
}: SmartLabelControlsProps) {
  const patchThread = useMailboxStore((state) => state.patchThread);
  const [isManaging, setIsManaging] = useState(false);
  const [prediction, setPrediction] = useState<LabelPrediction | null>(null);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const storedLabelId = label?.labelId ?? null;
  const currentLabel =
    prediction && prediction.storedLabelId === storedLabelId
      ? prediction.label
      : label;

  async function handleSetLabel(labelId: string) {
    if (currentLabel?.labelId === labelId) {
      setIsManaging(false);
      return;
    }
    const definition = availableLabels.find(
      (candidate) => candidate.id === labelId,
    );
    if (!definition) return;
    const previousLabel = currentLabel;
    const nextLabel: InvookThreadLabel = {
      labelId: definition.id,
      name: definition.name,
      source: "user",
      confidence: null,
    };
    setPendingLabel(labelId);
    setError(null);
    setPrediction({ storedLabelId, label: nextLabel });
    // The cached row reflects the change immediately; the mailbox change event
    // that follows the label write reconciles it against stored state.
    patchThread({ threadId, patch: { invookLabel: nextLabel } });
    try {
      await setThreadLabel({ threadId, labelId });
      setIsManaging(false);
    } catch (cause) {
      setPrediction(null);
      patchThread({ threadId, patch: { invookLabel: previousLabel } });
      setError(apiErrorMessage(cause, "Invook could not save this label."));
    } finally {
      setPendingLabel(null);
    }
  }

  return (
    <div className="relative flex min-w-0 items-center justify-end gap-1.5">
      <div
        className="flex min-w-0 items-center gap-1"
        aria-label={currentLabel ? "Thread label" : undefined}
      >
        {currentLabel ? (
          <span
            key={currentLabel.labelId}
            className="max-w-28 truncate rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground"
          >
            {currentLabel.name}
          </span>
        ) : null}
      </div>

      <Button
        type="button"
        variant="ghost"
        size={currentLabel ? "icon-sm" : "sm"}
        aria-label="Manage thread labels"
        aria-expanded={isManaging}
        onClick={() => setIsManaging((current) => !current)}
        className="text-muted-foreground"
      >
        <HugeiconsIcon icon={Tag01Icon} size={15} />
        {!currentLabel ? <span>Labels</span> : null}
      </Button>

      {isManaging ? (
        <div className="absolute right-0 top-9 z-40 w-64 rounded-xl bg-popover p-2.5 text-popover-foreground shadow-xl ring-1 ring-border/55">
          <p className="px-2 pb-1.5 text-xs font-semibold">Manage labels</p>
          {availableLabels.length > 0 ? (
            <div className="space-y-0.5" role="group" aria-label="Available labels">
              {availableLabels.map((definition) => {
                const isApplied = currentLabel?.labelId === definition.id;
                return (
                  <Button
                    key={definition.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start gap-2 px-2 text-xs"
                    aria-pressed={isApplied}
                    disabled={pendingLabel !== null}
                    onClick={() => void handleSetLabel(definition.id)}
                  >
                    <span className="flex size-4 items-center justify-center">
                      {isApplied ? (
                        <HugeiconsIcon icon={Tick02Icon} size={13} />
                      ) : null}
                    </span>
                    <span className="truncate">{definition.name}</span>
                  </Button>
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              No labels are available.
            </p>
          )}
          {error ? (
            <p role="alert" className="px-2 pt-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
