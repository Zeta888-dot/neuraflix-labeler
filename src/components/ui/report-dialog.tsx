"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/**
 * Report an issue dialog, shared by the modules that release a claim. The note
 * is required, so the caller blocks submit while it is empty.
 */
export function ReportDialog({
  open,
  title = "Report an issue",
  description,
  noteLabel,
  note,
  error,
  pending,
  onNoteChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title?: string;
  description: string;
  noteLabel: string;
  note: string;
  error: string | null;
  pending: boolean;
  onNoteChange: (note: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      noteRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      className="fixed inset-0 m-auto h-fit w-[calc(100%-2rem)] max-w-md rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
    >
      <h2 id={titleId} className="text-display-sm font-semibold">
        {title}
      </h2>
      <p id={descriptionId} className="mt-2 text-body-sm text-body">
        {description}
      </p>

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label htmlFor="report-note" className="text-body-sm font-medium text-ink">
          {noteLabel}
        </label>
        <textarea
          ref={noteRef}
          id="report-note"
          name="report-note"
          rows={4}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          className={cn(
            "w-full resize-y rounded-md bg-surface px-3 py-2 text-body-sm text-ink",
            "shadow-elev-1",
            "transition-colors duration-150 ease-[var(--ease-out-quart)]",
            error && "ring-1 ring-error",
          )}
        />
        {error ? (
          <p id={errorId} role="alert" className="text-caption text-error">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending" : "Send report"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
