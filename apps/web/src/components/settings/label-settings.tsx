"use client";

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type {
  CreateInvookLabelRequest,
  InvookLabel,
  LabelHistoryWindowDays,
  PreviewInvookLabelRequest,
} from "@invook/contracts";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  createInvookLabel,
  previewInvookLabel,
  setInvookLabelEnabled,
} from "@/lib/api/labels";
import { apiErrorMessage } from "@/lib/http-error";

import { CreateLabelDialog } from "./create-label-dialog";
import { listLabelSettingsItems } from "./label-settings-items";
import { LabelSettingsRow } from "./label-settings-row";

export interface LabelSettingsProps {
  accountId: string;
  invookLabels: InvookLabel[];
  onChanged: () => void | Promise<void>;
}

export function LabelSettings({
  accountId,
  invookLabels,
  onChanged,
}: LabelSettingsProps) {
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [pendingLabelKey, setPendingLabelKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const labels = listLabelSettingsItems(invookLabels);

  function handleOpenEditor() {
    setError(null);
    setIsEditorOpen(true);
  }

  async function handleCreateLabel(request: CreateInvookLabelRequest) {
    await createInvookLabel(request, accountId);
    await onChanged();
  }

  function handlePreviewLabel(request: PreviewInvookLabelRequest) {
    return previewInvookLabel(request, accountId);
  }

  async function handleSetEnabled(
    label: InvookLabel,
    isEnabled: boolean,
    applyToPastDays: LabelHistoryWindowDays | null = null,
  ) {
    setPendingLabelKey(label.id);
    setError(null);
    try {
      await setInvookLabelEnabled(label.id, { isEnabled, applyToPastDays });
      await onChanged();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not update this label."));
    } finally {
      setPendingLabelKey(null);
    }
  }

  return (
    <section className="w-full px-5 py-6 pr-12 sm:px-8 sm:py-7 sm:pr-12">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-[-0.025em]">Labels</h2>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={handleOpenEditor}
        >
          <HugeiconsIcon icon={Add01Icon} size={14} />
          Add label
        </Button>
      </div>

      <div className="mt-5 space-y-0.5" role="list" aria-label="Invook labels">
        {labels.map((item) => {
          const label = item.label;
          return (
            <div key={label.id} role="listitem">
              <LabelSettingsRow
                name={label.name}
                description={label.description}
                status={`${label.systemKey === null ? "Custom" : "Built-in"} · ${label.isEnabled ? "Enabled" : "Disabled"}`}
                isEnabled={label.isEnabled}
                canDisable={item.canDisable}
                isPending={pendingLabelKey === label.id}
                onDisable={() => handleSetEnabled(label, false)}
                onEnable={(applyToPastDays) =>
                  handleSetEnabled(label, true, applyToPastDays)
                }
              />
            </div>
          );
        })}
        {labels.length === 0 ? (
          <div className="rounded-xl bg-muted/25 px-6 py-12 text-center">
            <p className="text-sm font-medium">No labels</p>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Invook labels will appear here.
            </p>
          </div>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {isEditorOpen ? (
        <CreateLabelDialog
          onClose={() => setIsEditorOpen(false)}
          onCreate={handleCreateLabel}
          onPreview={handlePreviewLabel}
        />
      ) : null}
    </section>
  );
}
