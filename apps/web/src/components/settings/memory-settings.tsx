"use client";

import { Add01Icon, Brain02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AccountSyncStage, MemoryEntry, MemoryType } from "@invook/contracts";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { deleteMemory } from "@/lib/api/memories";
import { apiErrorMessage } from "@/lib/http-error";

import { displayedMemoryTypes, memoryDefinitions } from "./memory-definitions";
import { MemoryEditorDialog } from "./memory-editor-dialog";
import { MemoryList } from "./memory-list";

interface MemoryEditorState {
  key: string;
  type: MemoryType;
  memoryId?: string;
  initialStatement: string;
  initialContactEmail: string;
}

export interface MemorySettingsProps {
  accountId: string;
  memories: MemoryEntry[];
  syncState: AccountSyncStage;
  aiConfigured: boolean;
  onChanged: () => void | Promise<void>;
}

function isMemoryType(value: string): value is MemoryType {
  return value === "preference" || value === "contact" || value === "scheduling";
}

export function MemorySettings({
  accountId,
  memories,
  syncState,
  aiConfigured,
  onChanged,
}: MemorySettingsProps) {
  const [activeType, setActiveType] = useState<MemoryType>("preference");
  const [editor, setEditor] = useState<MemoryEditorState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const statusLabel =
    !aiConfigured && syncState !== "complete"
      ? "AI setup needed"
      : syncState === "complete"
        ? "Ready"
        : syncState === "failed"
          ? "Needs attention"
          : "Analyzing sent mail";

  function handleOpenAdd() {
    setError(null);
    setEditor({
      key: `add:${activeType}`,
      type: activeType,
      initialStatement: "",
      initialContactEmail: "",
    });
  }

  function handleOpenEdit(memory: MemoryEntry) {
    setActiveType(memory.type);
    setError(null);
    setEditor({
      key: `edit:${memory.id}`,
      type: memory.type,
      memoryId: memory.id,
      initialStatement: memory.statement,
      initialContactEmail: memory.contactEmail ?? "",
    });
  }

  async function handleDeleteMemory(memory: MemoryEntry) {
    setError(null);
    try {
      await deleteMemory(memory.id);
      await onChanged();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not delete this memory."));
    }
  }

  async function handleMemorySaved() {
    setEditor(null);
    await onChanged();
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <HugeiconsIcon icon={Brain02Icon} size={20} className="text-primary" />
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.03em]">Memory</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">Used whenever Invook drafts</p>
            </div>
          </div>
          <p className="mt-5 max-w-xl text-sm leading-6 text-muted-foreground">
            Memory is the set of explicit and learned rules Invook applies to replies. You can
            add, correct, or delete every rule.
          </p>
          {!aiConfigured ? (
            <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
              Add an AI model to analyze sent mail. You can still add Memory yourself.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1 text-xs text-muted-foreground">
          <span
            className={`size-1.5 rounded-full ${
              syncState === "failed"
                ? "bg-destructive"
                : syncState === "complete"
                  ? "bg-success"
                  : "bg-primary"
            }`}
          />
          {statusLabel}
        </div>
      </div>

      <Tabs
        value={activeType}
        onValueChange={(value) => isMemoryType(value) && setActiveType(value)}
        className="mt-7"
      >
        <div className="flex items-center justify-between gap-3">
          <TabsList variant="line" className="h-9">
            {displayedMemoryTypes.map((type) => {
              const definition = memoryDefinitions[type];
              const count = memories.filter((memory) => memory.type === type).length;
              return (
                <TabsTrigger key={type} value={type} className="gap-1.5 px-3 text-[13px]">
                  <HugeiconsIcon icon={definition.icon} size={13} />
                  {definition.label}
                  <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                </TabsTrigger>
              );
            })}
          </TabsList>
          <Button type="button" size="sm" onClick={handleOpenAdd}>
            <HugeiconsIcon icon={Add01Icon} size={13} />
            Add
          </Button>
        </div>

        {displayedMemoryTypes.map((type) => (
          <TabsContent key={type} value={type}>
            <p className="mt-5 text-sm leading-6 text-muted-foreground">
              {memoryDefinitions[type].description}
            </p>
            <MemoryList
              type={type}
              memories={memories.filter((memory) => memory.type === type)}
              onEdit={handleOpenEdit}
              onDelete={handleDeleteMemory}
              onAdd={handleOpenAdd}
            />
          </TabsContent>
        ))}
      </Tabs>

      {error ? (
        <p role="alert" className="mt-4 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {editor ? (
        <MemoryEditorDialog
          accountId={accountId}
          key={editor.key}
          type={editor.type}
          memoryId={editor.memoryId}
          initialStatement={editor.initialStatement}
          initialContactEmail={editor.initialContactEmail}
          onClose={() => setEditor(null)}
          onSaved={handleMemorySaved}
        />
      ) : null}
    </div>
  );
}
