"use client";

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";

export interface QuotedTextToggleProps {
  controls?: string;
  isExpanded: boolean;
  onToggle: () => void;
}

export function QuotedTextToggle({
  controls,
  isExpanded,
  onToggle,
}: QuotedTextToggleProps) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-xs"
      className="mt-4 h-5 w-7 rounded-full bg-background/55 text-muted-foreground shadow-none"
      aria-label={isExpanded ? "Hide quoted text" : "Show quoted text"}
      aria-controls={controls}
      aria-expanded={isExpanded}
      onClick={onToggle}
    >
      <HugeiconsIcon icon={MoreHorizontalIcon} size={13} />
    </Button>
  );
}
