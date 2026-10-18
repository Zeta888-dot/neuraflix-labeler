"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Modal panel built on the native <dialog> element: focus trapping, Escape
 * handling and inertness come from the platform, so there is no custom
 * focus-trap code to get wrong. Used for the mobile navigation drawer.
 */
export function Sheet({
  open,
  onOpenChange,
  label,
  side = "left",
  className,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the dialog. */
  label: string;
  side?: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClose={() => onOpenChange(false)}
      onClick={(event) => {
        // The dialog element itself is the backdrop area.
        if (event.target === ref.current) onOpenChange(false);
      }}
      className={cn(
        "fixed inset-y-0 m-0 h-dvh max-h-none w-full max-w-[288px] p-0",
        "bg-transparent text-ink backdrop:bg-black/50",
        side === "left" ? "left-0" : "right-0",
        className,
      )}
    >
      <div
        className="sheet-panel flex h-full flex-col bg-surface shadow-elev-5"
        style={
          {
            "--sheet-shift": side === "left" ? "-12px" : "12px",
          } as CSSProperties
        }
      >
        {children}
      </div>
    </dialog>
  );
}
