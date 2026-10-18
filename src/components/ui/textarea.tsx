import type { TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Textarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md bg-surface px-3 py-2 text-body-sm text-ink",
        "shadow-elev-1 outline-none",
        "transition-colors duration-150 ease-[var(--ease-out-quart)]",
        "hover:border-hairline-strong",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}
