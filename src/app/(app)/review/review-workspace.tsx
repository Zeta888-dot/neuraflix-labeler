"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page";
import {
  conversationTurnsChanged,
  emptyReviewCounts,
  instructionValuesChanged,
  REVIEW_KINDS,
  reviewConversationSchema,
  reviewInstructionSchema,
  reviewKindLabels,
  reviewOcrSchema,
  reviewTextSchema,
  type ReviewCounts,
  type ReviewDecision,
  type ReviewDecisionInput,
  type ReviewItem,
  type ReviewKind,
  type ReviewQueue,
} from "@/lib/review";
import {
  conversationTranslationSchema,
  instructionTranslationSchema,
  plainTextSubmissionSchema,
  type ConversationTurn,
  type InstructionTranslationValues,
  type KhowarFieldErrors,
} from "@/lib/khowar";
import { validateLabel } from "@/lib/ocr/labels";
import { submitReviewDecision, loadReviewQueue, refreshReviewImages } from "./actions";
import {
  ConversationReviewCard,
  InstructionReviewCard,
  OcrReviewCard,
  TextReviewCard,
  type OcrDraftLine,
} from "./review-cards";
import { RejectDialog } from "./reject-dialog";
import { cn } from "@/lib/cn";

/**
 * The review workspace. It owns the editable copy of the current item, validates
 * in the browser with the same schemas the action uses, and replaces the item
 * after each decision. The server action is still the only writer.
 */

type Draft =
  | { kind: "instruction"; values: InstructionTranslationValues }
  | { kind: "conversation"; turns: ConversationTurn[] }
  | { kind: "text"; text: string }
  | { kind: "ocr"; lines: OcrDraftLine[] }
  | null;

type DraftErrors = {
  instruction: KhowarFieldErrors;
  turns: Record<number, string>;
  text: string | null;
};

const emptyDraftErrors: DraftErrors = {
  instruction: {},
  turns: {},
  text: null,
};

function draftFromItem(item: ReviewItem | null): Draft {
  if (!item) return null;

  if (item.kind === "instruction") {
    return { kind: "instruction", values: { ...item.values } };
  }
  if (item.kind === "conversation") {
    return {
      kind: "conversation",
      turns: item.turns.map((turn) => ({ ...turn })),
    };
  }
  if (item.kind === "text") {
    return { kind: "text", text: item.text };
  }

  return {
    kind: "ocr",
    lines: item.lines.map((line) => ({
      ...line,
      originalLabel: line.label,
      reject: false,
      error: null,
    })),
  };
}

function countSubmitted(counts: ReviewCounts): number {
  return REVIEW_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}

export function ReviewWorkspace({
  initialQueue,
  initialKind,
}: {
  initialQueue: ReviewQueue;
  initialKind: ReviewKind;
}) {
  const [kind, setKind] = useState<ReviewKind>(initialKind);
  const [queue, setQueue] = useState<ReviewQueue>(initialQueue);
  const [counts, setCounts] = useState<ReviewCounts>(
    initialQueue.status === "ok" ? initialQueue.counts : emptyReviewCounts,
  );
  const [allowSelfReview, setAllowSelfReview] = useState(
    initialQueue.status === "ok" ? initialQueue.allowSelfReview : false,
  );
  const [reviewsDone, setReviewsDone] = useState<number | null>(
    initialQueue.status === "ok" ? initialQueue.reviewsDone : null,
  );
  const [draft, setDraft] = useState<Draft>(() =>
    draftFromItem(initialQueue.status === "ok" ? initialQueue.item : null),
  );
  const [errors, setErrors] = useState<DraftErrors>(emptyDraftErrors);

  const [pending, setPending] = useState(false);
  const [queuePending, setQueuePending] = useState<ReviewKind | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialQueue.status === "error" ? initialQueue.message : null,
  );

  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  const item = queue.status === "ok" ? queue.item : null;
  const busy = pending || queuePending !== null;

  function applyQueue(next: ReviewQueue) {
    setQueue(next);
    setKind(next.kind);
    if (next.status === "ok") {
      setCounts(next.counts);
      setAllowSelfReview(next.allowSelfReview);
      if (next.reviewsDone !== null) setReviewsDone(next.reviewsDone);
      setDraft(draftFromItem(next.item));
      setErrors(emptyDraftErrors);
    } else {
      setDraft(null);
    }
  }

  async function switchQueue(nextKind: ReviewKind) {
    if (nextKind === kind || busy) return;

    setKind(nextKind);
    setQueuePending(nextKind);
    setMessage(null);
    setErrorMessage(null);
    setRejectOpen(false);
    setDraft(null);
    setErrors(emptyDraftErrors);

    const next = await loadReviewQueue(nextKind);
    setQueuePending(null);
    applyQueue(next);
    if (next.status === "error") setErrorMessage(next.message);
  }

  async function reloadCurrent() {
    if (busy) return;
    setQueuePending(kind);
    setMessage(null);
    setErrorMessage(null);

    const next = await loadReviewQueue(kind);
    setQueuePending(null);
    applyQueue(next);
    if (next.status === "error") setErrorMessage(next.message);
  }

  function setInstructionValue(
    field: keyof InstructionTranslationValues,
    value: string,
  ) {
    setDraft((current) =>
      current?.kind === "instruction"
        ? {
            ...current,
            values: { ...current.values, [field]: value },
          }
        : current,
    );
    setErrors((current) => ({
      ...current,
      instruction: { ...current.instruction, [field]: undefined },
    }));
  }

  function setTurnValue(index: number, value: string) {
    setDraft((current) => {
      if (current?.kind !== "conversation") return current;
      return {
        ...current,
        turns: current.turns.map((turn, turnIndex) =>
          turnIndex === index ? { ...turn, content: value } : turn,
        ),
      };
    });
    setErrors((current) => {
      if (!(index in current.turns)) return current;
      const turns = { ...current.turns };
      delete turns[index];
      return { ...current, turns };
    });
  }

  function setTextValue(value: string) {
    setDraft((current) =>
      current?.kind === "text" ? { ...current, text: value } : current,
    );
    setErrors((current) => ({ ...current, text: null }));
  }

  function setOcrLabel(idx: number, label: string) {
    setDraft((current) => {
      if (current?.kind !== "ocr") return current;
      return {
        ...current,
        lines: current.lines.map((line) =>
          line.idx === idx ? { ...line, label, error: null } : line,
        ),
      };
    });
  }

  function toggleOcrReject(idx: number) {
    setDraft((current) => {
      if (current?.kind !== "ocr") return current;
      return {
        ...current,
        lines: current.lines.map((line) =>
          line.idx === idx ? { ...line, reject: !line.reject } : line,
        ),
      };
    });
  }

  async function retryImages(): Promise<boolean> {
    if (!item || item.kind !== "ocr" || draft?.kind !== "ocr" || retrying) {
      return false;
    }

    setRetrying(true);
    const result = await refreshReviewImages(item.id);
    setRetrying(false);

    if (result.status === "error") {
      setErrorMessage(result.message);
      return false;
    }

    setDraft((current) => {
      if (current?.kind !== "ocr") return current;
      return {
        ...current,
        lines: current.lines.map((line) => ({
          ...line,
          imageUrl: result.urls[line.idx] ?? null,
        })),
      };
    });
    return true;
  }

  function validateDraft(): boolean {
    if (!item || !draft) return false;

    if (item.kind === "instruction" && draft.kind === "instruction") {
      const parsed = instructionTranslationSchema(item.english).safeParse(
        draft.values,
      );
      if (!parsed.success) {
        const fieldErrors: KhowarFieldErrors = {};
        for (const issue of parsed.error.issues) {
          const field = issue.path[0];
          if (typeof field === "string" && !(field in fieldErrors)) {
            fieldErrors[field as keyof KhowarFieldErrors] = issue.message;
          }
        }
        setErrors({ ...emptyDraftErrors, instruction: fieldErrors });
        return false;
      }
      return true;
    }

    if (item.kind === "conversation" && draft.kind === "conversation") {
      const parsed = conversationTranslationSchema(item.english).safeParse({
        turns: draft.turns,
      });
      if (!parsed.success) {
        const turnErrors: Record<number, string> = {};
        let formError: string | null = null;
        for (const issue of parsed.error.issues) {
          const index = issue.path[0] === "turns" ? issue.path[1] : undefined;
          if (typeof index === "number") {
            if (!(index in turnErrors)) turnErrors[index] = issue.message;
          } else if (!formError) {
            formError = issue.message;
          }
        }
        setErrors({ ...emptyDraftErrors, turns: turnErrors });
        if (formError) setErrorMessage(formError);
        return false;
      }
      return true;
    }

    if (item.kind === "text" && draft.kind === "text") {
      const parsed = plainTextSubmissionSchema.safeParse({
        title: "",
        khowar_text: draft.text,
        source_note: "",
        rights_confirmed: true,
      });
      if (!parsed.success) {
        const issue = parsed.error.issues.find(
          (entry) => entry.path[0] === "khowar_text",
        );
        setErrors({
          ...emptyDraftErrors,
          text: issue?.message ?? "Check the text before approving.",
        });
        return false;
      }
      return true;
    }

    if (item.kind === "ocr" && draft.kind === "ocr") {
      let kept = 0;
      let failed = false;
      const lines = draft.lines.map((line) => {
        if (line.reject) return line;
        const result = validateLabel(line.label);
        if (!result.ok) {
          failed = true;
          return { ...line, error: result.error };
        }
        kept += 1;
        return { ...line, error: null };
      });

      setDraft({ ...draft, lines });

      if (failed) return false;
      if (kept < 1) {
        setErrorMessage("Keep at least one line before approving the page.");
        return false;
      }
      return true;
    }

    return false;
  }

  function buildDecision(
    decision: ReviewDecision,
    note: string,
  ): ReviewDecisionInput | null {
    if (!item || !draft || item.kind !== draft.kind) return null;

    if (item.kind === "instruction" && draft.kind === "instruction") {
      return {
        kind: "instruction",
        translationId: item.id,
        decision,
        note,
        english: item.english,
        values: draft.values,
      };
    }
    if (item.kind === "conversation" && draft.kind === "conversation") {
      return {
        kind: "conversation",
        translationId: item.id,
        decision,
        note,
        englishTurns: item.english.turns,
        turns: draft.turns,
      };
    }
    if (item.kind === "text" && draft.kind === "text") {
      return {
        kind: "text",
        submissionId: item.id,
        decision,
        note,
        text: draft.text,
      };
    }
    if (item.kind === "ocr" && draft.kind === "ocr") {
      return {
        kind: "ocr",
        pageId: item.id,
        decision,
        note,
        lines: draft.lines.map((line) => ({
          idx: line.idx,
          label: line.label,
          reject: line.reject,
        })),
      };
    }

    return null;
  }

  function clientSchemaError(payload: ReviewDecisionInput): string | null {
    if (payload.kind === "instruction") {
      const parsed = reviewInstructionSchema().safeParse(payload);
      return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the fields.");
    }
    if (payload.kind === "conversation") {
      const parsed = reviewConversationSchema().safeParse(payload);
      return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the turns.");
    }
    if (payload.kind === "text") {
      const parsed = reviewTextSchema().safeParse(payload);
      return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the text.");
    }
    const parsed = reviewOcrSchema().safeParse(payload);
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the lines.");
  }

  async function handleApprove() {
    if (busy || !item || !draft) return;

    setMessage(null);
    setErrorMessage(null);

    if (!validateDraft()) {
      setErrorMessage("Check the highlighted fields before approving.");
      return;
    }

    const payload = buildDecision("approve", "");
    if (!payload) {
      setErrorMessage("The item changed. Reload the queue.");
      return;
    }

    const schemaError = clientSchemaError(payload);
    if (schemaError) {
      setErrorMessage(schemaError);
      return;
    }

    setPending(true);
    const result = await submitReviewDecision(payload);
    setPending(false);

    if (result.status === "blocked") {
      if (result.queue) applyQueue(result.queue);
      setErrorMessage(result.message);
      return;
    }

    applyQueue(result.queue);
    setMessage(result.message);
  }

  function openReject() {
    if (busy || !item) return;
    setRejectNote("");
    setRejectError(null);
    setRejectOpen(true);
  }

  async function handleReject() {
    if (busy || !item || !draft) return;

    const note = rejectNote.trim();
    if (note.length < 3) {
      setRejectError("Add a note of at least 3 characters before rejecting.");
      return;
    }

    const payload = buildDecision("reject", note);
    if (!payload) {
      setRejectError("The item changed. Close this dialog and reload the queue.");
      return;
    }

    setRejectError(null);
    setPending(true);
    const result = await submitReviewDecision(payload);
    setPending(false);

    if (result.status === "blocked") {
      if (result.queue) {
        applyQueue(result.queue);
        setRejectOpen(false);
      }
      setErrorMessage(result.message);
      if (!result.queue) setRejectError(result.message);
      return;
    }

    setRejectOpen(false);
    setRejectNote("");
    applyQueue(result.queue);
    setMessage(result.message);
  }

  const changed =
    item && draft
      ? item.kind === "instruction" && draft.kind === "instruction"
        ? instructionValuesChanged(item, draft.values)
        : item.kind === "conversation" && draft.kind === "conversation"
          ? conversationTurnsChanged(item, draft.turns)
          : item.kind === "text" && draft.kind === "text"
            ? draft.text !== item.text
            : draft.kind === "ocr"
              ? draft.lines.some(
                  (line) => line.reject || line.label !== line.originalLabel,
                )
              : false
      : false;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, button, a, summary, [contenteditable='true'], [role='dialog'], [role='menuitem']",
        )
      ) {
        return;
      }
      if (rejectOpen || busy || !item) return;

      const key = event.key.toLowerCase();
      if (key === "a") {
        event.preventDefault();
        void handleApprove();
      } else if (key === "r") {
        event.preventDefault();
        openReject();
      } else if (/^[1-4]$/.test(key)) {
        const next = REVIEW_KINDS[Number(key) - 1];
        if (next) {
          event.preventDefault();
          void switchQueue(next);
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const loadingLabel = queuePending
    ? `Loading ${reviewKindLabels[queuePending].toLowerCase()}`
    : null;

  return (
    <div className="mt-6 flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>Queues</CardTitle>
            <p className="mt-1 text-body-sm text-body">
              {countSubmitted(counts)} submitted{" "}
              {countSubmitted(counts) === 1 ? "item" : "items"} waiting. Oldest
              first.
            </p>
          </div>
          <p className="text-body-sm text-body">
            Your reviews:{" "}
            <span className="font-medium tabular-nums text-ink">
              {reviewsDone ?? "not available"}
            </span>
          </p>
        </div>

        <div
          role="group"
          aria-label="Review queues"
          className="mt-4 flex gap-2 overflow-x-auto pb-1"
        >
          {REVIEW_KINDS.map((queueKind) => {
            const selected = kind === queueKind;
            return (
              <button
                key={queueKind}
                type="button"
                aria-pressed={selected}
                aria-controls="review-panel"
                onClick={() => void switchQueue(queueKind)}
                disabled={busy}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-body-sm font-medium transition-colors",
                  selected
                    ? "bg-solid text-on-solid"
                    : "bg-surface-2 text-body hover:text-ink",
                  "disabled:opacity-60",
                )}
              >
                <span>{reviewKindLabels[queueKind]}</span>
                <span className="tabular-nums">{counts[queueKind]}</span>
              </button>
            );
          })}
        </div>

        {allowSelfReview ? (
          <p
            role="note"
            className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-body-sm text-accent-text"
          >
            Self review is on for this environment. You can review your own
            contributions. Turn it off in app_settings when testing is done.
          </p>
        ) : null}

        {loadingLabel ? (
          <p role="status" className="mt-3 text-body-sm text-mute">
            {loadingLabel}...
          </p>
        ) : null}

        <div aria-live="polite" className="min-h-0">
          {message ? (
            <p role="status" className="mt-3 text-body-sm text-body">
              {message}
            </p>
          ) : null}
          {errorMessage ? (
            <p role="alert" className="mt-3 text-body-sm text-error">
              {errorMessage}
            </p>
          ) : null}
        </div>
      </Card>

      <div id="review-panel" aria-busy={busy}>
        {queue.status === "error" ? (
          <EmptyState title="The queue could not be loaded">
            <p>{queue.message}</p>
            <div className="mt-4">
              <Button
                type="button"
                variant="secondary"
                className="h-11"
                onClick={() => void reloadCurrent()}
                disabled={busy}
              >
                Reload queue
              </Button>
            </div>
          </EmptyState>
        ) : queue.item === null || draft === null ? (
          <EmptyState title="Nothing to review right now">
            <p>
              No submitted items are waiting in this queue. New work appears
              here oldest first.
            </p>
          </EmptyState>
        ) : item?.kind === "instruction" && draft.kind === "instruction" ? (
          <InstructionReviewCard
            key={item.id}
            item={item}
            values={draft.values}
            errors={errors.instruction}
            disabled={busy}
            onChange={setInstructionValue}
          />
        ) : item?.kind === "conversation" && draft.kind === "conversation" ? (
          <ConversationReviewCard
            key={item.id}
            item={item}
            turns={draft.turns}
            errors={errors.turns}
            disabled={busy}
            onChange={setTurnValue}
          />
        ) : item?.kind === "text" && draft.kind === "text" ? (
          <TextReviewCard
            key={item.id}
            item={item}
            text={draft.text}
            error={errors.text}
            disabled={busy}
            onChange={setTextValue}
          />
        ) : item?.kind === "ocr" && draft.kind === "ocr" ? (
          <OcrReviewCard
            key={item.id}
            item={item}
            lines={draft.lines}
            disabled={busy}
            retrying={retrying}
            onChange={setOcrLabel}
            onToggleReject={toggleOcrReject}
            onRetryImages={retryImages}
          />
        ) : (
          <EmptyState title="Nothing to review right now">
            <p>
              No submitted items are waiting in this queue. New work appears
              here oldest first.
            </p>
          </EmptyState>
        )}

        {queue.status === "ok" && queue.item !== null && draft !== null ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              className="h-11"
              onClick={() => void handleApprove()}
              disabled={busy}
            >
              {pending
                ? "Saving"
                : changed
                  ? item?.kind === "ocr"
                    ? "Edit and approve page"
                    : "Edit and approve"
                  : item?.kind === "ocr"
                    ? "Approve page"
                    : "Approve"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-11"
              onClick={openReject}
              disabled={busy}
            >
              Reject
            </Button>
            <p className="text-caption text-mute">
              Keyboard: A approve, R reject, 1 to 4 switch queues.
            </p>
          </div>
        ) : null}
      </div>

      <RejectDialog
        open={rejectOpen}
        pending={pending}
        note={rejectNote}
        error={rejectError}
        itemLabel={item?.kind === "ocr" ? "page" : "item"}
        onNoteChange={(note) => {
          setRejectNote(note);
          setRejectError(null);
        }}
        onClose={() => {
          if (!pending) setRejectOpen(false);
        }}
        onSubmit={() => void handleReject()}
      />
    </div>
  );
}
