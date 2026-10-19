"use client";

import {
  ArrowClockwise,
  Flag,
  PaperPlaneTilt,
  SkipForward,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/page";
import { ReportDialog } from "@/components/ui/report-dialog";
import { KhowarField } from "@/components/khowar/KhowarField";
import { cn } from "@/lib/cn";
import {
  clearInstructionDraft,
  hasInstructionText,
  readInstructionDraft,
  writeInstructionDraft,
} from "@/lib/instruction-drafts";
import type { ClaimResult, WorkspaceData } from "@/lib/instructions";
import {
  emptyInstructionValues,
  instructionFieldWarnings,
  khowarFieldNames,
  validateInstructionTranslation,
  type InstructionTranslationValues,
  type KhowarFieldErrors,
} from "@/lib/khowar";
import {
  claimInstruction,
  reportInstructionIssue,
  skipInstruction,
  submitInstruction,
} from "./actions";
import { EnglishPanel } from "./english-panel";

type Notice = { tone: "info" | "error"; message: string };
type Busy = null | "load" | "submit" | "skip" | "report";

/* Drafts are written this long after the last keystroke. */
const DRAFT_DELAY_MS = 400;

export function InstructionsWorkspace({
  initialSubmitted,
}: {
  initialSubmitted: number | null;
}) {
  const [claim, setClaim] = useState<ClaimResult | null>(null);
  const [submitted, setSubmitted] = useState(initialSubmitted);
  const [values, setValues] = useState<InstructionTranslationValues>(
    emptyInstructionValues,
  );
  const [errors, setErrors] = useState<KhowarFieldErrors>({});
  const [fieldWarnings, setFieldWarnings] = useState<KhowarFieldErrors>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [draftRestored, setDraftRestored] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);

  const instructionRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const responseRef = useRef<HTMLTextAreaElement | null>(null);
  const refs = {
    khowar_instruction: instructionRef,
    khowar_input: inputRef,
    khowar_response: responseRef,
  } as const;

  const applyWorkspace = useCallback(
    (data: WorkspaceData, options?: { preserveTypedFor?: string }) => {
      setSubmitted(data.submitted);
      setClaim(data.claim);
      setErrors({});
      setFieldWarnings({});
      setWarnings([]);

      if (data.claim.status !== "claimed") {
        setValues(emptyInstructionValues());
        setDraftRestored(false);
        return;
      }

      if (options?.preserveTypedFor === data.claim.item.id) {
        setDraftRestored(false);
        return;
      }

      const draft = readInstructionDraft(data.claim.item.id);
      setValues(draft ?? emptyInstructionValues());
      setDraftRestored(draft !== null);
    },
    [],
  );

  const load = useCallback(async () => {
    setBusy("load");
    const data = await claimInstruction();
    setBusy(null);
    applyWorkspace(data);
  }, [applyWorkspace]);

  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    void load();
  }, [load]);

  const itemId = claim?.status === "claimed" ? claim.item.id : null;

  // Draft autosave, one localStorage key per item.
  useEffect(() => {
    if (!itemId || !hasInstructionText(values)) return;
    const timer = setTimeout(() => writeInstructionDraft(itemId, values), DRAFT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [itemId, values]);

  function focusFirstError(nextErrors: KhowarFieldErrors) {
    for (const field of khowarFieldNames) {
      if (nextErrors[field]) {
        refs[field].current?.focus();
        return;
      }
    }
  }

  function setField(field: keyof InstructionTranslationValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function keepEditing() {
    const firstWarned = khowarFieldNames.find((field) => fieldWarnings[field]);
    setWarnings([]);
    setFieldWarnings({});
    if (firstWarned) refs[firstWarned].current?.focus();
  }

  async function submit(options?: { acknowledged?: boolean }) {
    if (claim?.status !== "claimed" || busy !== null) return;
    const item = claim.item;

    const validation = validateInstructionTranslation(item.english, values);
    if (!validation.success) {
      setErrors(validation.errors);
      setFieldWarnings({});
      setWarnings([]);
      setNotice({
        tone: "error",
        message: "Fix the highlighted fields, then submit again.",
      });
      focusFirstError(validation.errors);
      return;
    }

    const acknowledged = options?.acknowledged === true;
    if (validation.warnings.length > 0 && !acknowledged) {
      setErrors({});
      setFieldWarnings(instructionFieldWarnings(item.english, values));
      setWarnings(validation.warnings);
      setNotice(null);
      return;
    }

    setBusy("submit");
    setNotice(null);
    const result = await submitInstruction({
      itemId: item.id,
      english: item.english,
      values,
      acknowledgeWarnings: acknowledged,
    });
    setBusy(null);

    if (result.status === "invalid") {
      setErrors(result.errors);
      setFieldWarnings({});
      setWarnings([]);
      setNotice({
        tone: "error",
        message: "Fix the highlighted fields, then submit again.",
      });
      focusFirstError(result.errors);
      return;
    }

    if (result.status === "warnings") {
      setFieldWarnings(instructionFieldWarnings(item.english, values));
      setWarnings(result.warnings);
      return;
    }

    if (result.status === "error") {
      setNotice({ tone: "error", message: result.message });
      return;
    }

    if (result.status === "expired") {
      applyWorkspace(result.workspace, { preserveTypedFor: item.id });
      setNotice({
        tone: "info",
        message:
          "Your claim expired after 30 minutes. The item was claimed again and your text is kept.",
      });
      return;
    }

    clearInstructionDraft(item.id);
    const sameItem = result.workspace.claim.status === "claimed" && result.workspace.claim.item.id === item.id;
    applyWorkspace(result.workspace, sameItem ? { preserveTypedFor: item.id } : undefined);
    setNotice({
      tone: "info",
      message:
        "Translation submitted. Thank you. The next item is ready.",
    });
  }

  async function skip() {
    if (claim?.status !== "claimed" || busy !== null) return;
    const item = claim.item;
    setBusy("skip");
    setNotice(null);
    const result = await skipInstruction(item.id);
    setBusy(null);

    if (result.status === "error") {
      setNotice({ tone: "error", message: result.message });
      return;
    }

    clearInstructionDraft(item.id);
    applyWorkspace(result.workspace);
    setNotice({ tone: "info", message: "Item released. The next item is ready." });
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
    const item = claim.item;
    const note = reportNote.trim();
    if (note === "") {
      setReportError("Add a short note about the problem.");
      return;
    }

    setBusy("report");
    const result = await reportInstructionIssue({ itemId: item.id, note });
    setBusy(null);

    if (result.status === "invalid" || result.status === "error") {
      setReportError(result.message);
      return;
    }

    setReportNote("");
    closeReport();
    applyWorkspace(result.workspace);
    setNotice({
      tone: "info",
      message: "Issue reported and the item released. The next item is ready.",
    });
  }

  return (
    <div className="mt-6">
      {submitted !== null ? (
        <p className="text-body-sm text-mute">
          You have submitted {submitted}{" "}
          {submitted === 1 ? "translation" : "translations"}
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
          <p className="text-body-sm text-mute">Finding the next item for you...</p>
        </Card>
      ) : claim.status === "empty" ? (
        <div className="mt-4">
          <EmptyState title="No items are available right now">
            <p>
              Every open instruction is claimed by another contributor or
              already translated. New items appear here once an admin imports
              them.
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
          <EmptyState title="The next item could not be loaded">
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
          <div className="grid gap-4 lg:grid-cols-2 lg:gap-6">
            <EnglishPanel item={claim.item} />

            <Card className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>Khowar</CardTitle>
                {draftRestored ? (
                  <span className="text-caption text-mute">
                    Draft restored from this browser
                  </span>
                ) : null}
              </div>

              <KhowarField
                id="khowar_instruction"
                label="Instruction"
                rows={4}
                value={values.khowar_instruction}
                onChange={(value) => setField("khowar_instruction", value)}
                error={errors.khowar_instruction}
                warning={fieldWarnings.khowar_instruction}
                fieldRef={instructionRef}
                disabled={busy !== null}
              />

              {claim.item.english.input ? (
                <KhowarField
                  id="khowar_input"
                  label="Input"
                  rows={3}
                  value={values.khowar_input}
                  onChange={(value) => setField("khowar_input", value)}
                  error={errors.khowar_input}
                  warning={fieldWarnings.khowar_input}
                  fieldRef={inputRef}
                  disabled={busy !== null}
                />
              ) : null}

              <KhowarField
                id="khowar_response"
                label="Response"
                rows={4}
                value={values.khowar_response}
                onChange={(value) => setField("khowar_response", value)}
                error={errors.khowar_response}
                warning={fieldWarnings.khowar_response}
                fieldRef={responseRef}
                disabled={busy !== null}
              />
            </Card>
          </div>

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
              <Button type="submit" disabled={busy !== null}>
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
              <p className="ml-auto hidden text-caption text-mute sm:block">
                Ctrl + Enter to submit
              </p>
            </div>
          </div>
        </form>
      )}

      <ReportDialog
        open={reportOpen}
        description="The report goes to the admins together with the English item. Your claim is released and the next item is loaded."
        noteLabel="What is wrong with this item?"
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

