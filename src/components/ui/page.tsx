import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Page heading block: one h1 per page, optional short description. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-display-md font-semibold tracking-[-0.04em]">
          {title}
        </h1>
        {description ? (
          <p className="max-w-[65ch] text-body-sm text-body">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex gap-2">{actions}</div> : null}
    </header>
  );
}

/** Honest empty state for a module that is not built yet. */
export function EmptyState({
  title,
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { title: string; children?: ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg bg-surface px-6 py-10 shadow-elev-2",
        className,
      )}
      {...props}
    >
      <h2 className="text-body-md font-medium text-ink">{title}</h2>
      {children ? (
        <div className="mt-2 max-w-[65ch] text-body-sm text-body">{children}</div>
      ) : null}
    </div>
  );
}
