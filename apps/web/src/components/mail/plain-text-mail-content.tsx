"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

import { splitMailBodyQuotedContent } from "./mail-format";
import { QuotedTextToggle } from "./quoted-text-toggle";

export interface PlainTextMailContentProps {
  bodyText: string;
  className?: string;
}

export function PlainTextMailContent({
  bodyText,
  className,
}: PlainTextMailContentProps) {
  const [isQuotedExpanded, setIsQuotedExpanded] = useState(false);
  const { visibleText, quotedText } = splitMailBodyQuotedContent(bodyText);

  return (
    <div className={cn("min-w-0", className)}>
      <div className="whitespace-pre-wrap break-words">
        {visibleText || "This email has no readable body."}
      </div>
      {quotedText ? (
        <>
          <QuotedTextToggle
            isExpanded={isQuotedExpanded}
            onToggle={() => setIsQuotedExpanded((value) => !value)}
          />
          {isQuotedExpanded ? (
            <div className="mt-4 whitespace-pre-wrap break-words border-l border-border/60 pl-4 text-foreground/68">
              {quotedText}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
