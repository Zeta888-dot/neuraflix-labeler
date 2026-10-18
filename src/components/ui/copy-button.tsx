"use client";

import { Check, Copy } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/** Copies a value to the clipboard and announces the result. */
export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <span className={cn("inline-flex items-center", className)}>
      <button
        type="button"
        onClick={copy}
        aria-label={state === "copied" ? `${label} (copied)` : label}
        className="inline-flex size-8 items-center justify-center rounded-full text-mute transition-colors hover:bg-surface-2 hover:text-ink"
      >
        {state === "copied" ? (
          <Check size={14} weight="light" aria-hidden="true" />
        ) : (
          <Copy size={14} weight="light" aria-hidden="true" />
        )}
      </button>
      <span role="status" className="sr-only">
        {state === "copied"
          ? "Copied to the clipboard"
          : state === "failed"
            ? "Copy failed. Select the text instead."
            : ""}
      </span>
    </span>
  );
}
