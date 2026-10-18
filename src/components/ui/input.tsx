import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Single-line input. Labels sit above the field, helper or error text below. */
export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-10 w-full rounded-md bg-surface px-3 text-body-sm text-ink",
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
