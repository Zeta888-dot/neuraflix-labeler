"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** Native dialog for the destructive and submit choices on the OCR page. */
export function ConfirmDialog({
  open,
  title,
  body,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="ocr-confirm-title"
      aria-describedby="ocr-confirm-body"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onCancel();
      }}
      className="m-auto w-[min(92vw,460px)] rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
    >
      <h2 id="ocr-confirm-title" className="text-display-sm font-semibold">
        {title}
      </h2>
      <div id="ocr-confirm-body" className="mt-2 text-body-sm text-body">
        {children ?? <p>{body}</p>}
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-11 sm:h-10"
          onClick={onCancel}
          autoFocus
        >
          {cancelLabel}
        </Button>
        <Button type="button" className="h-11 sm:h-10" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
