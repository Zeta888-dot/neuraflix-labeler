"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const REASONS = [
  "Looks machine translated",
  "Meaning does not match the English",
  "Spelling or letters need work",
  "Content is missing or extra",
  "This is not Khowar",
  "Wrong roles or turn order",
];

/**
 * Reject dialog with quick reason chips. A chip appends its phrase to the note
 * and the reviewer can edit the result. The note is required, so the database
 * and the action both refuse a rejection without one.
 */
export function RejectDialog({
  open,
  pending,
  note,
  error,
  itemLabel,
  onNoteChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  note: string;
  error: string | null;
  itemLabel: string;
  onNoteChange: (note: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
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

  function addReason(reason: string) {
    if (note.includes(reason)) return;
    const trimmed = note.trim();
    onNoteChange(trimmed === "" ? `${reason}.` : `${trimmed} ${reason}.`);
    noteRef.current?.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClose={() => {
        if (open && !pending) onClose();
      }}
      className="fixed inset-0 m-auto h-fit max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
    >
      <h2 id={titleId} className="text-display-sm font-semibold">
        Reject {itemLabel}
      </h2>
      <p className="mt-1 text-body-sm text-body">
        The contributor sees this note with the rejected contribution.
      </p>

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <p className="text-body-sm font-medium text-ink">Quick reasons</p>
        <div className="flex flex-wrap gap-2">
          {REASONS.map((reason) => (
            <button
              key={reason}
              type="button"
              aria-pressed={note.includes(reason)}
              onClick={() => addReason(reason)}
              className={cn(
                "inline-flex min-h-11 items-center rounded-full px-3 text-caption",
                "bg-surface-2 text-body transition-colors hover:text-ink",
                note.includes(reason) && "bg-accent-soft text-accent-text",
              )}
            >
              {reason}
            </button>
          ))}
        </div>

        <label htmlFor="review-reject-note" className="mt-2 text-body-sm font-medium text-ink">
          Note
        </label>
        <textarea
          ref={noteRef}
          id="review-reject-note"
          name="review-reject-note"
          rows={4}
          maxLength={2000}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          className={cn(
            "w-full resize-y rounded-md bg-surface px-3 py-2 text-body-sm text-ink",
            "shadow-elev-1 outline-none",
            "transition-colors duration-150 ease-[var(--ease-out-quart)]",
            error && "ring-1 ring-error",
          )}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-mute">
          <span>{note.trim().length} characters</span>
          <span>At least 3 characters</span>
        </div>
        {error ? (
          <p id={errorId} role="alert" className="text-caption text-error">
            {error}
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" className="h-11" disabled={pending}>
            {pending ? "Rejecting" : "Reject with note"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
