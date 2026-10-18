import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-full font-medium " +
  "whitespace-nowrap transition-colors duration-150 ease-[var(--ease-out-quart)] " +
  "disabled:pointer-events-none disabled:opacity-50 " +
  "active:translate-y-px";

const variants: Record<Variant, string> = {
  primary: "bg-solid text-on-solid hover:bg-solid-hover",
  secondary:
    "bg-surface text-ink shadow-elev-1 hover:bg-surface-2",
  ghost: "text-body hover:bg-surface-2 hover:text-ink",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-body-sm",
  md: "h-10 px-4 text-body-sm",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}): string {
  return cn(base, variants[variant], sizes[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
}) {
  return (
    <button
      type={type}
      className={buttonClasses({ variant, size, className })}
      {...props}
    />
  );
}
