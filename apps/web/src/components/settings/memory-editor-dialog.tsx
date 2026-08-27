"use client";

import type { MemoryType } from "@invook/contracts";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveMemory } from "@/lib/api/memories";
import { apiErrorMessage } from "@/lib/http-error";

import { memoryDefinitions } from "./memory-definitions";

export interface MemoryEditorDialogProps {
  accountId: string;
  type: MemoryType;
  memoryId?: string;
  initialStatement: string;
  initialContactEmail: string;
  onClose: () => void;
  onSaved: () => void;
}

export function MemoryEditorDialog({
  accountId,
  type,
  memoryId,
  initialStatement,
  initialContactEmail,
  onClose,
  onSaved,
}: MemoryEditorDialogProps) {
  const [statement, setStatement] = useState(initialStatement);
  const [contactEmail, setContactEmail] = useState(initialContactEmail);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await saveMemory({
        accountId,
        memoryId,
        type,
        contactEmail: type === "contact" ? contactEmail : null,
        statement,
      });
      setPending(false);
      onSaved();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Invook could not save this memory."));
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {memoryId ? "Edit" : "Add"} {memoryDefinitions[type].singular}
            </DialogTitle>
            <DialogDescription>
              Write one clear rule. User-written changes always take priority over inferred
              memory.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-5 space-y-4">
            {type === "contact" ? (
              <label className="block space-y-1.5 text-sm font-medium">
                Email address
                <Input
                  type="email"
                  required
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value)}
                  autoComplete="off"
                />
              </label>
            ) : null}
            <label className="block space-y-1.5 text-sm font-medium">
              Memory
              <Textarea
                required
                minLength={3}
                maxLength={500}
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
                className="min-h-28 resize-none"
                autoFocus={type !== "contact"}
              />
            </label>
          </div>

          {error ? (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-5">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save memory"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
