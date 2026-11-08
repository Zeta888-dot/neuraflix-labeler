"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  buildRejectNote,
  rejectReasons,
  type RejectReasonId,
} from "@/lib/review";
import { cn } from "@/lib/cn";

const OTHER_MIN = 5;

/**
 * Reject dialog with a fixed reason list. The note that reaches the database is
 * the reason label, or "Other: ..." with a short explanation. The reject never
 * happens on the first click: the dialog states what will be rejected first.
 */
export function RejectDialog({
  open,
  pending,
  error,
  itemLabel,
  detail,
  onClose,
  onSubmit,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  itemLabel: string;
  detail: string;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const otherRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy = [hintId, error ? errorId : null].filter(Boolean).join(" ");

  const [reason, setReason] = useState<RejectReasonId>("not_khowar");
  const [other, setOther] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (reason === "other") otherRef.current?.focus();
  }, [reason]);

  function submit() {
    if (reason === "other" && other.trim().length < OTHER_MIN) {
      setLocalError("Add at least 5 characters about the problem.");
      otherRef.current?.focus();
      return;
    }
    setLocalError(null);
    onSubmit(buildRejectNote(reason, other));
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClose={() => {
        setReason("not_khowar");
        setOther("");
        setLocalError(null);
        if (open && !pending) onClose();
      }}
      className="fixed inset-0 m-auto h-fit max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
    >
      <h2 id={titleId} className="text-display-sm font-semibold">
        Reject {itemLabel}
      </h2>
      <p id={descriptionId} className="mt-1 text-body-sm text-body">
        {detail}
      </p>

      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset>
          <legend className="text-body-sm font-medium text-ink">
            Reason
          </legend>
          <div className="mt-2 flex flex-col gap-2">
            {rejectReasons.map((entry) => {
              const selected = reason === entry.id;
              return (
                <label
                  key={entry.id}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-body-sm",
                    selected
                      ? "bg-accent-soft text-accent-text"
                      : "bg-surface-2 text-body",
                  )}
                >
                  <input
                    type="radio"
                    name="review-reject-reason"
                    value={entry.id}
                    checked={selected}
                    onChange={() => setReason(entry.id)}
                    className="accent-current"
                  />
                  {entry.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {reason === "other" ? (
          <>
            <label
              htmlFor="review-reject-other"
              className="mt-2 text-body-sm font-medium text-ink"
            >
              What is wrong?
            </label>
            <textarea
              ref={otherRef}
              id="review-reject-other"
              rows={4}
              maxLength={2000}
              value={other}
              onChange={(event) => setOther(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={localError || error ? true : undefined}
              className={cn(
                "w-full resize-y rounded-md bg-surface px-3 py-2 text-body-sm text-ink",
                "shadow-elev-1",
                "transition-colors duration-150 ease-[var(--ease-out-quart)]",
                (localError || error) && "ring-1 ring-error",
              )}
            />
            <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-mute">
              <span>{other.trim().length} characters</span>
              <span id={hintId}>At least 5 characters</span>
            </div>
          </>
        ) : null}

        {localError || error ? (
          <p id={errorId} role="alert" className="text-caption text-error">
            {localError ?? error}
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
            {pending ? "Rejecting" : `Reject ${itemLabel}`}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
