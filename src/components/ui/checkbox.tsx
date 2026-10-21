import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Native checkbox with a visible focus ring, wrapped in a label row. */
export function Checkbox({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 text-body-sm text-body pointer-coarse:min-h-11 pointer-coarse:items-center",
        className,
      )}
    >
      <input
        type="checkbox"
        className={cn(
          "mt-0.5 size-4 shrink-0 rounded-xs appearance-none",
          "bg-surface shadow-elev-1",
          "checked:bg-accent checked:shadow-[inset_0_0_0_1px_var(--accent)]",
          "relative after:absolute after:inset-0 after:hidden",
          "checked:after:block checked:after:bg-[var(--selection-fg)]",
          "checked:after:[clip-path:polygon(18%_52%,42%_74%,84%_26%,72%_16%,40%_54%,28%_42%)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
        {...props}
      />
      <span className="leading-5">{label}</span>
    </label>
  );
}
