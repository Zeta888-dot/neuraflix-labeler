import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const tones = {
  neutral: "bg-surface-2 text-body",
  accent: "bg-accent-soft text-accent-text",
  error: "bg-surface-2 text-error",
} as const;

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-caption",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
