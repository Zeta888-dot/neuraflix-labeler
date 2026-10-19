"use client";

import {
  ArrowClockwise,
  ArrowDown,
  Flag,
  PaperPlaneTilt,
  SkipForward,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import {
  createRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page";
import { ReportDialog } from "@/components/ui/report-dialog";
import { cn } from "@/lib/cn";
import {
  clearConversationDraft,
  readConversationDraft,
  writeConversationDraft,
} from "@/lib/conversation-drafts";
import type { ClaimResult, WorkspaceData } from "@/lib/conversations";
import {
  conversationTurnWarnings,
  emptyConversationValues,
  firstEmptyTurn,
  hasConversationText,
  validateConversationTranslation,
  type ConversationFieldErrors,
  type ConversationTranslationValues,
} from "@/lib/khowar";
import {
  claimConversation,
  reportConversationIssue,
  skipConversation,
  submitConversation,
} from "./actions";
import { ConversationTurnCard } from "./conversation-turn";

type Notice = { tone: "info" | "error"; message: string };
type Busy = null | "load" | "submit" | "skip" | "report";

/* Drafts are written this long after the last keystroke. */
const DRAFT_DELAY_MS = 400;

const noErrors: ConversationFieldErrors = { form: null, turns: {} };

export function ConversationsWorkspace({
  initialSubmitted,
}: {
  initialSubmitted: number | null;
}) {
  const [claim, setClaim] = useState<ClaimResult | null>(null);
  const [submitted, setSubmitted] = useState(initialSubmitted);
  const [values, setValues] = useState<ConversationTranslationValues>({
    turns: [],
  });
  const [errors, setErrors] = useState<ConversationFieldErrors>(noErrors);
  const [fieldWarnings, setFieldWarnings] = useState<Record<number, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draftRestored, setDraftRestored] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);

  /* One textarea ref per turn index, created on demand and reused, so focus
     can move to a turn without remounting it. */
  const fieldRefs = useRef<Record<number, RefObject<HTMLTextAreaElement | null>>>({});

  const applyWorkspace = useCallback(
    (data: WorkspaceData, options?: { preserveTypedFor?: string }) => {
      setSubmitted(data.submitted);
      setClaim(data.claim);
      setErrors(noErrors);
      setFieldWarnings({});
      setWarnings([]);

      if (data.claim.status !== "claimed") {
        setValues({ turns: [] });
        setDraftRestored(false);
        return;
      }

      if (options?.preserveTypedFor === data.claim.item.id) {
        setDraftRestored(false);
        return;
      }

      const draft = readConversationDraft(
        data.claim.item.id,
        data.claim.item.english,
      );
      setValues(draft ?? emptyConversationValues(data.claim.item.english));
      setDraftRestored(draft !== null);
    },
    [],
  );

  const load = useCallback(async () => {
    setBusy("load");
    const data = await claimConversation();
    setBusy(null);
    applyWorkspace(data);
  }, [applyWorkspace]);

  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    void load();
  }, [load]);

  const item = claim?.status === "claimed" ? claim.item : null;
  const itemId = item?.id ?? null;

  // Draft autosave, one localStorage key per conversation.
  useEffect(() => {
    if (!itemId || !hasConversationText(values)) return;
    const timer = setTimeout(
      () => writeConversationDraft(itemId, values),
      DRAFT_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [itemId, values]);

  function scrollToTurn(index: number) {
    const node = fieldRefs.current[index]?.current;
    if (!node) return;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({
      block: "center",
      behavior: reduceMotion ? "auto" : "smooth",
    });
    node.focus({ preventScroll: true });
  }

  function focusFirstError(nextErrors: ConversationFieldErrors) {
    const indexes = Object.keys(nextErrors.turns)
      .map(Number)
      .sort((a, b) => a - b);
    if (indexes.length > 0) scrollToTurn(indexes[0]);
  }

  function setTurnContent(index: number, content: string) {
    setValues((current) => ({
      turns: current.turns.map((turn, turnIndex) =>
        turnIndex === index ? { ...turn, content } : turn,
      ),
    }));
  }

  function keepEditing() {
    const indexes = Object.keys(fieldWarnings)
      .map(Number)
      .sort((a, b) => a - b);
    setWarnings([]);
    setFieldWarnings({});
    if (indexes.length > 0) scrollToTurn(indexes[0]);
  }

  async function submit(options?: { acknowledged?: boolean }) {
    if (claim?.status !== "claimed" || busy !== null) return;
    const current = claim.item;

    const validation = validateConversationTranslation(
      current.english,
      values,
    );
    if (!validation.success) {
      setErrors(validation.errors);
      setFieldWarnings({});
      setWarnings([]);
      setNotice({
        tone: "error",
        message:
          validation.errors.form ??
          "Fix the highlighted turns, then submit again.",
      });
      focusFirstError(validation.errors);
      return;
    }

    const acknowledged = options?.acknowledged === true;
    if (validation.warnings.length > 0 && !acknowledged) {
      setErrors(noErrors);
      setFieldWarnings(conversationTurnWarnings(current.english, values));
      setWarnings(validation.warnings);
      setNotice(null);
      return;
    }

    setBusy("submit");
    setNotice(null);
    const result = await submitConversation({
      itemId: current.id,
      english: current.english.turns,
      turns: values.turns,
      acknowledgeWarnings: acknowledged,
    });
    setBusy(null);

    if (result.status === "invalid") {
      setErrors(result.errors);
      setFieldWarnings({});
      setWarnings([]);
      setNotice({
        tone: "error",
        message:
          result.errors.form ?? "Fix the highlighted turns, then submit again.",
      });
      focusFirstError(result.errors);
      return;
    }

    if (result.status === "warnings") {
      setFieldWarnings(conversationTurnWarnings(current.english, values));
      setWarnings(result.warnings);
      return;
    }

    if (result.status === "error") {
      setNotice({ tone: "error", message: result.message });
      return;
    }

    if (result.status === "expired") {
      applyWorkspace(result.workspace, { preserveTypedFor: current.id });
      setNotice({
        tone: "info",
        message:
          "Your claim expired after 30 minutes. The next conversation is loaded and your text stays saved as a draft.",
      });
      return;
    }

    clearConversationDraft(current.id);
    const sameItem =
      result.workspace.claim.status === "claimed" &&
      result.workspace.claim.item.id === current.id;
    applyWorkspace(
      result.workspace,
      sameItem ? { preserveTypedFor: current.id } : undefined,
    );
    setNotice({
      tone: "info",
      message:
        "Translation submitted. Thank you. The next conversation is ready.",
    });
  }

  async function skip() {
    if (claim?.status !== "claimed" || busy !== null) return;
    const current = claim.item;
    setBusy("skip");
    setNotice(null);
    const result = await skipConversation(current.id);
    setBusy(null);

    if (result.status === "error") {
      setNotice({ tone: "error", message: result.message });
      return;
    }

    clearConversationDraft(current.id);
    applyWorkspace(result.workspace);
    setNotice({
      tone: "info",
      message: "Conversation released. The next one is ready.",
    });
  }

  function openReport() {
    setReportError(null);
    setReportOpen(true);
  }

  function closeReport() {
    setReportOpen(false);
    setReportError(null);
  }

  async function sendReport() {
    if (claim?.status !== "claimed" || busy !== null) return;
    const current = claim.item;
    const note = reportNote.trim();
    if (note === "") {
      setReportError("Add a short note about the problem.");
      return;
    }

    setBusy("report");
    const result = await reportConversationIssue({ itemId: current.id, note });
    setBusy(null);

    if (result.status === "invalid" || result.status === "error") {
      setReportError(result.message);
      return;
    }

    setReportNote("");
    clearConversationDraft(current.id);
    closeReport();
    applyWorkspace(result.workspace);
    setNotice({
      tone: "info",
      message:
        "Issue reported and the conversation released. The next one is ready.",
    });
  }

  function jumpToNextEmptyTurn() {
    const index = firstEmptyTurn(values);
    if (index !== null) {
      scrollToTurn(index);
      return;
    }

    const submitButton = document.getElementById("submit-conversation");
    submitButton?.scrollIntoView({ block: "center" });
    submitButton?.focus({ preventScroll: true });
    setNotice({
      tone: "info",
      message: "Every turn has text. Submit when you are ready.",
    });
  }

  const total = item ? item.english.turns.length : 0;
  const translated = values.turns.filter(
    (turn) => turn.content.trim() !== "",
  ).length;

  return (
    <div className="mt-6 max-w-3xl">
      {submitted !== null ? (
        <p className="text-body-sm text-mute">
          You have submitted {submitted}{" "}
          {submitted === 1 ? "conversation" : "conversations"}
        </p>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "mt-3 max-w-[75ch] text-body-sm",
            notice.tone === "error" ? "text-error" : "text-body",
          )}
        >
          {notice.message}
        </p>
      ) : null}

      {claim === null ? (
        <Card className="mt-4" role="status">
          <p className="text-body-sm text-mute">
            Finding the next conversation for you...
          </p>
        </Card>
      ) : claim.status === "empty" ? (
        <div className="mt-4">
          <EmptyState title="No conversations are available right now">
            <p>
              Every open conversation is claimed by another contributor or
              already translated. New conversations appear here once an admin
              imports them.
            </p>
            <Link
              href="/dashboard"
              className={buttonClasses({ variant: "secondary", size: "sm" }) + " mt-4"}
            >
              Back to the dashboard
            </Link>
          </EmptyState>
        </div>
      ) : claim.status === "error" ? (
        <div className="mt-4">
          <EmptyState title="The next conversation could not be loaded">
            <p>{claim.message}</p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-4"
              onClick={() => void load()}
              disabled={busy !== null}
            >
              <ArrowClockwise size={14} weight="light" aria-hidden="true" />
              Try again
            </Button>
          </EmptyState>
        </div>
      ) : (
        <form
          className="mt-4"
          aria-busy={busy !== null}
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body-sm text-mute">
              {total} {total === 1 ? "turn" : "turns"} in this conversation
            </p>
            {draftRestored ? (
              <span className="text-caption text-mute">
                Draft restored from this browser
              </span>
            ) : null}
          </div>

          <div className="mt-4 flex flex-col gap-4">
            {claim.item.english.turns.map((turn, index) => {
              const fieldRef = (fieldRefs.current[index] ??= createRef<
                HTMLTextAreaElement | null
              >());

              return (
                <ConversationTurnCard
                  key={index}
                  index={index}
                  total={total}
                  turn={turn}
                  value={values.turns[index]?.content ?? ""}
                  error={errors.turns[index]}
                  warning={fieldWarnings[index]}
                  disabled={busy !== null}
                  fieldRef={fieldRef}
                  onChange={(content) => setTurnContent(index, content)}
                />
              );
            })}
          </div>

          {claim.item.source ? (
            <p className="mt-3 text-caption text-mute">
              Source: {claim.item.source}
            </p>
          ) : null}

          {warnings.length > 0 ? (
            <div className="mt-4 rounded-lg bg-surface p-4 shadow-elev-2">
              <p className="flex items-center gap-2 text-body-sm font-medium text-ink">
                <WarningCircle
                  size={16}
                  weight="light"
                  aria-hidden="true"
                  className="text-accent-text"
                />
                Check before you submit
              </p>
              <ul className="mt-2 flex flex-col gap-1 text-body-sm text-body">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  type="button"
                  onClick={() => void submit({ acknowledged: true })}
                  disabled={busy !== null}
                >
                  Submit anyway
                </Button>
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={keepEditing}
                  disabled={busy !== null}
                >
                  Keep editing
                </Button>
              </div>
            </div>
          ) : null}

          <div className="sticky bottom-0 z-10 mt-6 -mx-4 border-t border-hairline bg-canvas/95 px-4 py-3 backdrop-blur lg:static lg:mx-0 lg:rounded-lg lg:border lg:border-hairline lg:bg-surface lg:px-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" id="submit-conversation" disabled={busy !== null}>
                {busy === "submit" ? (
                  "Submitting"
                ) : (
                  <>
                    <PaperPlaneTilt size={16} weight="light" aria-hidden="true" />
                    Submit and next
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void skip()}
                disabled={busy !== null}
              >
                <SkipForward size={16} weight="light" aria-hidden="true" />
                {busy === "skip" ? "Skipping" : "Skip"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={openReport}
                disabled={busy !== null}
              >
                <Flag size={16} weight="light" aria-hidden="true" />
                Report an issue
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="ml-auto"
                onClick={jumpToNextEmptyTurn}
                disabled={busy !== null}
              >
                <ArrowDown size={16} weight="light" aria-hidden="true" />
                Jump to next empty turn
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-caption text-mute">
                {translated} of {total} turns translated
              </p>
              <p className="hidden text-caption text-mute sm:block">
                Ctrl + Enter to submit
              </p>
            </div>
          </div>
        </form>
      )}

      <ReportDialog
        open={reportOpen}
        description="The report goes to the admins together with the English conversation. Your claim is released and the next conversation is loaded."
        noteLabel="What is wrong with this conversation?"
        note={reportNote}
        error={reportError}
        pending={busy === "report"}
        onNoteChange={setReportNote}
        onClose={closeReport}
        onSubmit={() => void sendReport()}
      />
    </div>
  );
}
