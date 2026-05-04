"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // ignore — fall through silently
        }
      }}
      className="rounded border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/30"
    >
      {copied ? "✓ 복사됨" : "📋 URL 복사"}
    </button>
  );
}
