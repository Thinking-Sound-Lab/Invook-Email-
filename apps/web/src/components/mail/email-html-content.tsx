"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { QuotedTextToggle } from "./quoted-text-toggle";

export interface EmailHtmlContentProps {
  className?: string;
  hasQuotedContent?: boolean;
  sanitizedHtml: string;
}

export function EmailHtmlContent({
  className,
  hasQuotedContent = false,
  sanitizedHtml,
}: EmailHtmlContentProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [isQuotedExpanded, setIsQuotedExpanded] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = sanitizedHtml;

    return () => shadowRoot.replaceChildren();
  }, [sanitizedHtml]);

  return (
    <div className={cn("block min-w-0 w-full", className)}>
      <div
        ref={hostRef}
        className="block min-w-0 w-full"
        data-show-quoted={isQuotedExpanded ? "true" : undefined}
        aria-label="Original email content"
      />
      {hasQuotedContent ? (
        <QuotedTextToggle
          isExpanded={isQuotedExpanded}
          onToggle={() => setIsQuotedExpanded((value) => !value)}
        />
      ) : null}
    </div>
  );
}
