"use client";

import { CheckCircle, PaperPlaneTilt } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page";
import { KhowarField } from "@/components/khowar/KhowarField";
import {
  PLAIN_TEXT_MAX,
  PLAIN_TEXT_MIN,
  plainTextFieldErrors,
  plainTextStats,
  plainTextSubmissionSchema,
  type PlainTextFieldErrors,
} from "@/lib/khowar";
import {
  PLAIN_TEXT_PAGE_SIZE,
  plainTextStatusLabels,
  type PlainTextPage,
  type PlainTextSubmission,
  type TextSubmissionStatus,
} from "@/lib/plain-text";
import {
  clearPlainTextDraft,
  readPlainTextDraft,
  writePlainTextDraft,
} from "@/lib/plain-text-drafts";
import { loadMorePlainText, submitPlainText } from "./actions";

const DRAFT_DELAY_MS = 400;

const STATUS_TONES: Record<
  TextSubmissionStatus,
  "neutral" | "accent" | "error"
> = {
  submitted: "neutral",
  approved: "accent",
  rejected: "error",
};

export function PlainTextWorkspace({
  initialPage,
}: {
  initialPage: PlainTextPage | null;
}) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [rights, setRights] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [busy, setBusy] = useState<null | "submit" | "more" | "reload">(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [items, setItems] = useState<PlainTextSubmission[]>(
    initialPage?.items ?? [],
  );
  const [nextOffset, setNextOffset] = useState<number | null>(
    initialPage?.nextOffset ?? null,
  );
  const [pageError, setPageError] = useState(initialPage === null);

  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const successRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    // localStorage is only available after mount. The short timer keeps the
    // restore out of the render pass and lets the server markup hydrate first.
    const timer = setTimeout(() => {
      if (cancelled) return;
      const draft = readPlainTextDraft();
      if (draft) {
        setTitle(draft.title);
        setText(draft.text);
        setSource(draft.source);
        setDraftRestored(true);
      }
      setDraftLoaded(true);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Draft autosave. The submitted check stops a pending timer from writing the
  // text back after a successful submit has cleared it.
  useEffect(() => {
    if (!draftLoaded || submitted) return;

    if (text === "" && title === "" && source === "") {
      clearPlainTextDraft();
      return;
    }

    const timer = setTimeout(
      () => writePlainTextDraft({ text, title, source }),
      DRAFT_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [draftLoaded, submitted, title, text, source]);

  useEffect(() => {
    if (submitted) successRef.current?.focus();
  }, [submitted]);

  const parsed = plainTextSubmissionSchema.safeParse({
    title,
    khowar_text: text,
    source_note: source,
    rights_confirmed: rights,
  });

  const errors: PlainTextFieldErrors = parsed.success
    ? {}
    : plainTextFieldErrors(parsed.error);
  const canSubmit = parsed.success;
  const disabledReason = parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "Check the form before submitting.");

  const stats = plainTextStats(text);
  const textError =
    errors.khowar_text && (showErrors || text.trim() !== "")
      ? errors.khowar_text
      : null;
  const titleError =
    errors.title && (showErrors || title.trim() !== "") ? errors.title : null;
  const sourceError =
    errors.source_note && (showErrors || source.trim() !== "")
      ? errors.source_note
      : null;
  const rightsError =
    errors.rights_confirmed && showErrors ? errors.rights_confirmed : null;

  function focusText() {
    const node = textRef.current;
    if (!node) return;
    node.focus();
    node.scrollIntoView({ block: "center" });
  }

  function clearDraft() {
    clearPlainTextDraft();
    setTitle("");
    setText("");
    setSource("");
    setRights(false);
    setShowErrors(false);
    setFormNotice(null);
    setDraftRestored(false);
    focusText();
  }

  function submitAnother() {
    setSubmitted(false);
    clearDraft();
    requestAnimationFrame(() => focusText());
  }

  async function reloadPage() {
    if (busy !== null) return;
    setBusy("reload");
    setListError(null);
    const result = await loadMorePlainText(0);
    setBusy(null);

    if (result.status === "error") {
      setPageError(true);
      setListError(result.message);
      return;
    }

    setItems(result.page.items);
    setNextOffset(result.page.nextOffset);
    setPageError(false);
  }

  async function loadMore() {
    if (nextOffset === null || busy !== null) return;
    setBusy("more");
    setListError(null);
    const result = await loadMorePlainText(nextOffset);
    setBusy(null);

    if (result.status === "error") {
      setListError(result.message);
      return;
    }

    setItems((current) => {
      const known = new Set(current.map((item) => item.id));
      return [
        ...current,
        ...result.page.items.filter((item) => !known.has(item.id)),
      ];
    });
    setNextOffset(result.page.nextOffset);
  }

  async function submit() {
    if (busy !== null || submitted) return;

    if (!parsed.success) {
      setShowErrors(true);
      setFormNotice(
        parsed.error.issues[0]?.message ?? "Check the form before submitting.",
      );
      focusText();
      return;
    }

    setBusy("submit");
    setFormNotice(null);

    const result = await submitPlainText({
      title,
      khowar_text: text,
      source_note: source,
      rights_confirmed: rights,
    });
    setBusy(null);

    if (result.status === "invalid") {
      setShowErrors(true);
      setFormNotice(
        result.errors.khowar_text ??
          result.errors.title ??
          result.errors.source_note ??
          result.errors.rights_confirmed ??
          "Check the form before submitting.",
      );
      focusText();
      return;
    }

    if (result.status === "duplicate" || result.status === "error") {
      setFormNotice(result.message);
      return;
    }

    const couldHaveMore =
      pageError || nextOffset !== null || items.length >= PLAIN_TEXT_PAGE_SIZE;
    const shown = Math.min(items.length + 1, PLAIN_TEXT_PAGE_SIZE);

    setItems((current) =>
      [result.item, ...current].slice(0, PLAIN_TEXT_PAGE_SIZE),
    );
    setNextOffset(couldHaveMore ? shown : null);
    setPageError(false);
    setSubmitted(true);
    setShowErrors(false);
    setFormNotice(null);
    setDraftRestored(false);
    clearPlainTextDraft();
  }

  return (
    <div className="mt-6 max-w-3xl">
      {submitted ? (
        <Card role="status" className="mt-4">
          <CheckCircle
            size={24}
            weight="light"
            aria-hidden="true"
            className="text-accent-text"
          />
          <h2
            ref={successRef}
            tabIndex={-1}
            className="mt-3 text-display-sm font-semibold text-ink"
          >
            Text submitted
          </h2>
          <p className="mt-2 max-w-[60ch] text-body-sm text-body">
            Thank you. Your text is in the review queue and now appears under
            Your submissions.
          </p>
          <Button className="mt-4" onClick={submitAnother}>
            Submit another
          </Button>
        </Card>
      ) : (
        <Card className="mt-4">
          <CardTitle>Add Khowar text</CardTitle>
          <p className="mt-1 max-w-[65ch] text-body-sm text-body">
            Paste or type a passage in Perso-Arabic script. Paragraph breaks
            are kept. Identical text is only accepted once.
          </p>

          <form
            noValidate
            aria-busy={busy !== null}
            className="mt-5 flex flex-col gap-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          >
            {formNotice ? (
              <p role="alert" className="text-body-sm text-error">
                {formNotice}
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              <label
                htmlFor="plain-text-title"
                className="text-body-sm font-medium text-ink"
              >
                Title <span className="text-mute">(optional)</span>
              </label>
              <Input
                id="plain-text-title"
                name="title"
                dir="auto"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setFormNotice(null);
                  setDraftRestored(false);
                }}
                disabled={busy !== null}
                aria-invalid={titleError ? true : undefined}
                aria-describedby={
                  titleError ? "plain-text-title-error" : undefined
                }
              />
              {titleError ? (
                <p
                  id="plain-text-title-error"
                  className="text-caption text-error"
                >
                  {titleError}
                </p>
              ) : null}
            </div>

            <div>
              <KhowarField
                id="plain-text-body"
                label="Text"
                value={text}
                onChange={(value) => {
                  setText(value);
                  setFormNotice(null);
                  setDraftRestored(false);
                }}
                rows={10}
                disabled={busy !== null}
                error={textError}
                fieldRef={textRef}
                showCount={false}
                textareaClassName="min-h-[280px]"
              />

              <dl
                aria-label="Text statistics"
                className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-caption text-mute"
              >
                <div className="flex gap-1.5">
                  <dt>Characters</dt>
                  <dd className="text-ink">
                    {stats.characters.toLocaleString("en")} of{" "}
                    {PLAIN_TEXT_MIN} to {PLAIN_TEXT_MAX.toLocaleString("en")}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>Words</dt>
                  <dd className="text-ink">
                    {stats.words.toLocaleString("en")}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>Arabic-script letters</dt>
                  <dd className="text-ink">{stats.arabicPercent}% (60% minimum)</dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-col gap-2">
              <label
                htmlFor="plain-text-source"
                className="text-body-sm font-medium text-ink"
              >
                Source <span className="text-mute">(optional)</span>
              </label>
              <Input
                id="plain-text-source"
                name="source_note"
                dir="auto"
                value={source}
                onChange={(event) => {
                  setSource(event.target.value);
                  setFormNotice(null);
                  setDraftRestored(false);
                }}
                disabled={busy !== null}
                placeholder="Where does this text come from? For example a book, a newspaper, your own writing"
                aria-invalid={sourceError ? true : undefined}
                aria-describedby={
                  sourceError ? "plain-text-source-error" : undefined
                }
              />
              {sourceError ? (
                <p
                  id="plain-text-source-error"
                  className="text-caption text-error"
                >
                  {sourceError}
                </p>
              ) : null}
            </div>

            <div>
              <Checkbox
                name="rights_confirmed"
                checked={rights}
                onChange={(event) => {
                  setRights(event.target.checked);
                  setFormNotice(null);
                }}
                disabled={busy !== null}
                aria-invalid={rightsError ? true : undefined}
                aria-describedby={
                  rightsError ? "plain-text-rights-error" : undefined
                }
                label="I wrote this text, it is in the public domain, or I have permission to share it."
              />
              {rightsError ? (
                <p
                  id="plain-text-rights-error"
                  className="mt-1 text-caption text-error"
                >
                  {rightsError}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 border-t border-hairline pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  disabled={busy !== null || !canSubmit}
                  aria-describedby={
                    !canSubmit ? "plain-text-submit-reason" : undefined
                  }
                >
                  <PaperPlaneTilt
                    size={16}
                    weight="light"
                    aria-hidden="true"
                  />
                  {busy === "submit" ? "Submitting" : "Submit"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={clearDraft}
                  disabled={busy !== null}
                >
                  Clear draft
                </Button>
                {draftRestored ? (
                  <span className="text-caption text-mute">
                    Draft restored from this browser
                  </span>
                ) : null}
              </div>

              {!canSubmit ? (
                <p
                  id="plain-text-submit-reason"
                  className="text-caption text-mute"
                >
                  {disabledReason}
                </p>
              ) : null}

              <p className="text-caption text-mute">Ctrl + Enter to submit</p>
            </div>
          </form>
        </Card>
      )}

      <section className="mt-8" aria-labelledby="your-submissions">
        <h2
          id="your-submissions"
          className="text-display-sm font-semibold text-ink"
        >
          Your submissions
        </h2>

        <div className="mt-3">
          {pageError ? (
            <EmptyState title="Your submissions could not be loaded">
              <p>
                {listError ??
                  "The database did not answer. Reload the page in a moment."}
              </p>
              <Button
                size="sm"
                variant="secondary"
                className="mt-4"
                onClick={() => void reloadPage()}
                disabled={busy !== null}
              >
                {busy === "reload" ? "Trying again" : "Try again"}
              </Button>
            </EmptyState>
          ) : items.length === 0 ? (
            <EmptyState title="No text submitted yet">
              <p>
                Your first plain text submission appears here after you submit
                it.
              </p>
            </EmptyState>
          ) : (
            <>
              <ul className="flex flex-col gap-3">
                {items.map((item) => (
                  <SubmissionItem key={item.id} item={item} />
                ))}
              </ul>

              {listError ? (
                <p role="alert" className="mt-3 text-body-sm text-error">
                  {listError}
                </p>
              ) : null}

              {nextOffset !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="mt-4"
                  onClick={() => void loadMore()}
                  disabled={busy !== null}
                >
                  {busy === "more" ? "Loading" : "Load more"}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function SubmissionItem({ item }: { item: PlainTextSubmission }) {
  return (
    <li className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {item.title ? (
            <p
              dir="auto"
              className="break-words text-body-md text-ink"
            >
              {item.title}
            </p>
          ) : (
            <p
              dir="rtl"
              lang="khw"
              className="script-nastaliq break-words text-body-md text-ink"
            >
              {item.preview}
            </p>
          )}

          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-mute">
            <time dateTime={item.createdAt}>{item.createdLabel}</time>
            <span>
              {item.characters.toLocaleString("en")}{" "}
              {item.characters === 1 ? "character" : "characters"}
            </span>
          </p>
        </div>

        <Badge tone={STATUS_TONES[item.status]}>
          {plainTextStatusLabels[item.status]}
        </Badge>
      </div>

      {item.status === "rejected" && item.reviewNote ? (
        <div className="mt-3 rounded-md bg-surface-2 px-3 py-2">
          <p className="text-caption font-medium text-ink">Reviewer note</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-body-sm text-body">
            {item.reviewNote}
          </p>
        </div>
      ) : null}
    </li>
  );
}
