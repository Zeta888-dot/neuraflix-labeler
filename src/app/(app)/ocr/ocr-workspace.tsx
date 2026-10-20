"use client";

import { UploadSimple } from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { isBitmapUsable } from "@/lib/ocr/bitmap";
import { cropToCanvas } from "@/lib/ocr/crop";
import { encodeLine } from "@/lib/ocr/encode";
import { logOcrSubmitError } from "@/lib/ocr/log";
import {
  DEFAULT_PARAMS,
  lineBoxesEqual,
  segParamsEqual,
  type LineBox,
  type SegParams,
} from "@/lib/ocr/segment-core";
import { trimHorizontally } from "@/lib/ocr/line-edits";
import {
  lineProgress,
  normalizeLabel,
  statusForLabel,
  type LineDraft,
} from "@/lib/ocr/labels";
import type { OcrStorageStatus } from "@/lib/ocr/pages";
import {
  buildUploadPlan,
  decideQuota,
  submitGate,
  type UploadPlanLine,
} from "@/lib/ocr/submit";
import {
  deleteOcrDraft,
  draftStoreMessage,
  readOcrDraft,
  writeOcrDraft,
  type OcrDraft,
  type OcrSubmission,
} from "@/lib/ocr/draft-store";
import {
  PageSegmenter,
  decodePageFile,
  segmenterErrorMessage,
  validatePageFile,
  type SegmentPageResult,
} from "@/lib/ocr/segmenter";
import { createClient } from "@/lib/supabase/client";
import { abortOcrPage, createOcrPage, finalizeOcrPage } from "./actions";
import { ConfirmDialog } from "./confirm-dialog";
import { DetectionPanel } from "./detection-panel";
import { LabelingView } from "./labeling-view";
import { LinesPanel } from "./lines-panel";
import { OcrErrorBoundary } from "./ocr-error-boundary";
import { PagePreview, type PageView } from "./page-preview";

const DEBOUNCE_MS = 250;
const DRAFT_SAVE_MS = 500;
const HISTORY_LIMIT = 30;
const UPLOAD_CONCURRENCY = 3;
const UPLOAD_RETRIES = 3;
const UPLOAD_BACKOFF_MS = 500;
const RESET_NOTICE =
  "Labels on the changed lines were reset or removed. Unchanged lines keep their labels.";
const QUOTA_FULL_NOTICE =
  "OCR uploads are full for now. Plain text, instructions and conversations are still open.";

type Busy = null | "load" | "detect";
type Step = "review" | "label" | "submit";
type HistoryEntry = { lines: LineDraft[]; selected: number; current: number };
type SaveState =
  | null
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };
type DialogKind =
  | "discard-draft"
  | "new-page"
  | "submit"
  | "cancel-submission"
  | null;

type PreparedLine = UploadPlanLine & {
  blob: Blob;
  type: "image/webp" | "image/jpeg";
  width: number;
  height: number;
  bytes: number;
};

type PreparedImage = Omit<PreparedLine, "storage_path"> & {
  extension: "webp" | "jpg";
};

type SubmitContext = {
  lines: readonly LineDraft[];
  label: string;
  rights: boolean;
  fileName: string;
  submission: OcrSubmission | null;
};

/** Thrown after a Stop or Cancel so the run can leave without an error card. */
class SubmissionHalted extends Error {
  constructor() {
    super("Submission stopped.");
    this.name = "SubmissionHalted";
  }
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "preparing"; done: number; total: number }
  | { kind: "creating" }
  | { kind: "uploading"; done: number; total: number }
  | { kind: "finalizing" }
  | { kind: "stopping" }
  | { kind: "cancelling" }
  | { kind: "error"; message: string; stage: "prepare" | "create" | "upload" | "finalize" }
  | { kind: "success"; lineCount: number };

let lineSequence = 0;

function newLineId(): string {
  lineSequence += 1;
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `line-${Date.now().toString(36)}-${lineSequence}`;
}

function makeLine(box: LineBox): LineDraft {
  return { id: newLineId(), box: [...box] as LineBox, label: "", status: "empty" };
}

function cloneLines(lines: readonly LineDraft[]): LineDraft[] {
  return lines.map((line) => ({ ...line, box: [...line.box] as LineBox }));
}

function sameBox(a: LineBox, b: LineBox): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function reconcileLines(
  boxes: LineBox[],
  previous: readonly LineDraft[],
): { lines: LineDraft[]; lostLabels: number } {
  const used = new Set<number>();
  const lines = boxes.map((box) => {
    const match = previous.findIndex(
      (line, index) => !used.has(index) && sameBox(line.box, box),
    );
    if (match === -1) return makeLine(box);
    used.add(match);
    return { ...previous[match], box: [...box] as LineBox };
  });

  let lostLabels = 0;
  previous.forEach((line, index) => {
    if (!used.has(index) && line.status !== "empty") lostLabels += 1;
  });

  return { lines, lostLabels };
}

function clampBox(box: LineBox, width: number, height: number): LineBox {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(box[0])));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(box[1])));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.round(box[2])));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.round(box[3])));
  return [x0, y0, x1, y1];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatClock(value: number): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatDraftTime(value: number): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

/**
 * A replaced page may still be referenced by a canvas effect that was already
 * scheduled. Keep it alive until the next task, then release it.
 */
function retireBitmap(bitmap: ImageBitmap | null | undefined) {
  if (!bitmap) return;
  window.setTimeout(() => bitmap.close(), 0);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Let React paint a progress update before the next line is encoded. */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

type BrowserSupabase = ReturnType<typeof createClient>;

function errorMessageOf(caught: unknown, fallback: string): string {
  if (caught && typeof caught === "object") {
    const message = (caught as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return fallback;
}

async function uploadWithRetry(
  supabase: BrowserSupabase,
  line: PreparedLine,
): Promise<void> {
  let lastError: { message?: string; code?: string } | null = null;

  for (let attempt = 0; attempt <= UPLOAD_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await wait(UPLOAD_BACKOFF_MS * 2 ** (attempt - 1));
    }

    const { error } = await supabase.storage
      .from("ocr-lines")
      .upload(line.storage_path, line.blob, {
        upsert: true,
        contentType: line.type,
      });

    if (!error) return;
    lastError = error;
  }

  throw lastError ?? new Error("The line image could not be uploaded.");
}

export function OcrWorkspace({
  userId,
  storageStatus,
}: {
  userId: string;
  storageStatus: OcrStorageStatus | null;
}) {
  const router = useRouter();
  const [page, setPage] = useState<PageView | null>(null);
  const [step, setStep] = useState<Step>("review");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState(0);
  const [originalSize, setOriginalSize] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const [params, setParams] = useState<SegParams>(DEFAULT_PARAMS);
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [detectedBoxes, setDetectedBoxes] = useState<LineBox[]>([]);
  const [selected, setSelected] = useState(0);
  const [currentLine, setCurrentLine] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [splitIndex, setSplitIndex] = useState<number | null>(null);
  const [splitY, setSplitY] = useState(0);
  const [lineNotice, setLineNotice] = useState<string | null>(null);

  const [pageLabel, setPageLabel] = useState("");
  const [rights, setRights] = useState(false);

  const [busy, setBusy] = useState<Busy>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pageVersion, setPageVersion] = useState(0);

  const [draftCheck, setDraftCheck] = useState<"checking" | "ready">(
    "checking",
  );
  const [savedDraft, setSavedDraft] = useState<OcrDraft | null>(null);
  const [draftStorageMessage, setDraftStorageMessage] = useState<string | null>(
    null,
  );
  const [draftBusy, setDraftBusy] = useState<null | "resume" | "discard">(
    null,
  );
  const [resumeMessage, setResumeMessage] = useState("");
  const [draftActionError, setDraftActionError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [recovering, setRecovering] = useState(false);

  const [submission, setSubmission] = useState<OcrSubmission | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });
  const [submitNotice, setSubmitNotice] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<{
    lineCount: number;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const segmenterRef = useRef<PageSegmenter | null>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const fileRef = useRef<Blob | null>(null);
  const recoveryRef = useRef(false);
  const loadTokenRef = useRef(0);
  const detectTokenRef = useRef(0);
  const saveTokenRef = useRef(0);
  const submitRunRef = useRef(0);
  const submitCancelRef = useRef(false);
  const submitStopRef = useRef(false);
  const submitActiveRef = useRef(false);
  const mountedRef = useRef(true);
  const manualEditsRef = useRef(false);
  const paramsRef = useRef(params);
  const appliedParamsRef = useRef<SegParams>(DEFAULT_PARAMS);
  const confirmOpenRef = useRef(false);
  const linesRef = useRef(lines);
  const submissionRef = useRef<OcrSubmission | null>(null);
  const preparedRef = useRef<PreparedImage[] | null>(null);
  const currentLineRef = useRef(currentLine);
  const pageLabelRef = useRef(pageLabel);
  const rightsRef = useRef(rights);

  const boxes = lines.map((line) => line.box);
  const manualEdits = !lineBoxesEqual(boxes, detectedBoxes);
  const gate = submitGate(lines, rights);
  const quotaDecision = storageStatus
    ? decideQuota(storageStatus.usedBytes, storageStatus.quotaBytes, 0)
    : "ok";
  const quotaBlocked = quotaDecision === "block";
  const effectiveGate = quotaBlocked
    ? {
        ...gate,
        canSubmit: false,
        reason: QUOTA_FULL_NOTICE,
      }
    : gate;
  const isSubmitting =
    submitState.kind === "preparing" ||
    submitState.kind === "creating" ||
    submitState.kind === "uploading" ||
    submitState.kind === "finalizing" ||
    submitState.kind === "stopping" ||
    submitState.kind === "cancelling";

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    currentLineRef.current = currentLine;
  }, [currentLine]);

  useEffect(() => {
    pageLabelRef.current = pageLabel;
  }, [pageLabel]);

  useEffect(() => {
    rightsRef.current = rights;
  }, [rights]);

  useEffect(() => {
    submissionRef.current = submission;
  }, [submission]);

  // A reload during an upload must warn, because the draft is the only record
  // of which lines already reached Storage.
  useEffect(() => {
    if (!isSubmitting) return;

    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isSubmitting]);

  useEffect(() => {
    manualEditsRef.current = manualEdits;
  }, [manualEdits]);

  useEffect(() => {
    confirmOpenRef.current = confirmOpen;
  }, [confirmOpen]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Stop a submit that is still running and make sure it cannot write to a
      // draft that belongs to a newer page after this one is unmounted.
      submitRunRef.current += 1;
      submitCancelRef.current = true;
      // StrictMode and Fast Refresh replay this effect while keeping the
      // page state. Let a new setup claim the page before it is released.
      queueMicrotask(() => {
        if (mountedRef.current) return;
        segmenterRef.current?.dispose();
        segmenterRef.current = null;
        const bitmap = bitmapRef.current;
        bitmapRef.current = null;
        bitmap?.close();
      });
    };
  }, []);

  // Read the one stored draft for this signed-in user.
  useEffect(() => {
    let cancelled = false;

    readOcrDraft(userId)
      .then((draft) => {
        if (cancelled) return;
        setSavedDraft(draft);
        setDraftCheck("ready");
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setDraftStorageMessage(draftStoreMessage(caught));
        setDraftCheck("ready");
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Autosave every change after a 500 ms pause. The page image is part of
  // the record and never leaves this browser.
  useEffect(() => {
    if (draftCheck !== "ready" || draftStorageMessage || submitSuccess) return;
    if (!page || !fileRef.current || !fileName) return;

    const token = ++saveTokenRef.current;
    const file = fileRef.current;
    setSaveState({ kind: "saving" });

    const timer = window.setTimeout(() => {
      if (!mountedRef.current || token !== saveTokenRef.current) return;

      writeOcrDraft(userId, {
        file,
        fileName,
        params,
        boxes: lines.map((line) => line.box),
        lines,
        currentLine,
        pageLabel,
        rightsConfirmed: rights,
        submission,
      })
        .then((saved) => {
          if (!mountedRef.current || token !== saveTokenRef.current) return;
          setSaveState({ kind: "saved", at: saved.updatedAt });
        })
        .catch((caught: unknown) => {
          if (!mountedRef.current || token !== saveTokenRef.current) return;
          setSaveState({
            kind: "error",
            message: draftStoreMessage(caught),
          });
        });
    }, DRAFT_SAVE_MS);

    return () => window.clearTimeout(timer);
  }, [
    draftCheck,
    draftStorageMessage,
    page,
    fileName,
    params,
    lines,
    currentLine,
    pageLabel,
    rights,
    submission,
    submitSuccess,
    userId,
  ]);

  // Escape leaves split mode from anywhere on the page.
  useEffect(() => {
    if (splitIndex === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSplitIndex(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [splitIndex]);

  const adoptPage = useCallback((result: SegmentPageResult): boolean => {
    if (!result.bitmap || !isBitmapUsable(result.bitmap)) return false;

    const previousBitmap = bitmapRef.current;
    bitmapRef.current = result.bitmap;
    setPage({
      bitmap: result.bitmap,
      width: result.width,
      height: result.height,
      angle: result.angle,
    });
    setPageVersion((version) => version + 1);
    retireBitmap(previousBitmap);
    return true;
  }, []);

  const applyDetection = useCallback(
    (result: SegmentPageResult, previous: readonly LineDraft[]) => {
      const reconciled = reconcileLines(result.boxes, previous);
      appliedParamsRef.current = result.params;
      setParams(result.params);
      setLines(reconciled.lines);
      setDetectedBoxes(result.boxes);
      setHistory([]);
      setSplitIndex(null);
      setSelected((current) =>
        Math.min(current, Math.max(0, reconciled.lines.length - 1)),
      );
      setCurrentLine((current) =>
        Math.min(current, Math.max(0, reconciled.lines.length - 1)),
      );
      if (reconciled.lostLabels > 0) setLineNotice(RESET_NOTICE);

      if (!adoptPage(result)) {
        result.bitmap?.close();
        setPage((current) =>
          current ? { ...current, angle: result.angle } : current,
        );
      }
    },
    [adoptPage],
  );

  const runDetection = useCallback(
    async (next: SegParams) => {
      const segmenter = segmenterRef.current;
      if (!segmenter || !isBitmapUsable(bitmapRef.current)) return;

      const token = ++detectTokenRef.current;
      setBusy("detect");
      setProgress("");
      setError(null);

      try {
        const result = await segmenter.update(next);
        if (!mountedRef.current || token !== detectTokenRef.current) {
          result.bitmap?.close();
          return;
        }
        applyDetection(result, linesRef.current);
      } catch (caught) {
        if (!mountedRef.current || token !== detectTokenRef.current) return;
        setError(
          segmenterErrorMessage(
            caught,
            "The lines could not be updated. Try changing a setting again.",
          ),
        );
        setParams(appliedParamsRef.current);
      } finally {
        if (token === detectTokenRef.current) setBusy(null);
      }
    },
    [applyDetection],
  );

  // A closed or detached bitmap cannot be drawn again. Decode the original
  // Blob, run the Worker once with the applied params, and keep the lines.
  const recoverPage = useCallback(async () => {
    const file = fileRef.current;
    if (!file || recoveryRef.current) return;

    recoveryRef.current = true;
    setRecovering(true);
    setBusy((current) => (current === "detect" ? null : current));
    const token = ++detectTokenRef.current;
    const nextParams = appliedParamsRef.current;

    let segmenter: PageSegmenter | null = null;
    let adopted = false;

    try {
      const bitmap = await decodePageFile(file);
      if (!mountedRef.current || token !== detectTokenRef.current) {
        bitmap.close();
        return;
      }

      try {
        segmenter = new PageSegmenter();
      } catch (caught) {
        bitmap.close();
        throw caught;
      }

      const result = await segmenter.load(bitmap, nextParams);
      if (!mountedRef.current || token !== detectTokenRef.current) {
        result.bitmap?.close();
        segmenter.dispose();
        return;
      }
      if (!result.bitmap || !isBitmapUsable(result.bitmap)) {
        result.bitmap?.close();
        segmenter.dispose();
        setError(
          "The page preview could not be rebuilt. Reload the page to try again.",
        );
        return;
      }

      const previousSegmenter = segmenterRef.current;
      appliedParamsRef.current = result.params;
      setParams(result.params);
      adopted = adoptPage(result);
      if (!adopted) {
        result.bitmap.close();
        segmenter.dispose();
        return;
      }
      segmenterRef.current = segmenter;
      previousSegmenter?.dispose();
    } catch (caught) {
      if (!adopted) segmenter?.dispose();
      if (!mountedRef.current || token !== detectTokenRef.current) return;
      setError(
        segmenterErrorMessage(
          caught,
          "The page preview could not be rebuilt. Reload the page to try again.",
        ),
      );
    } finally {
      recoveryRef.current = false;
      if (mountedRef.current) setRecovering(false);
    }
  }, [adoptPage]);

  // Fast Refresh or a release from another cleanup can leave a closed
  // bitmap in state. Rebuild it instead of drawing a detached image.
  useEffect(() => {
    if (!page || isBitmapUsable(page.bitmap)) return;

    const timer = window.setTimeout(() => {
      if (mountedRef.current) void recoverPage();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [page, recoverPage]);

  // Detection settings are debounced. When lines were edited by hand, ask
  // before the new detection replaces those edits.
  useEffect(() => {
    if (!page || busy !== null) return;
    if (segParamsEqual(params, appliedParamsRef.current)) return;

    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      if (manualEditsRef.current) {
        if (!confirmOpenRef.current) setConfirmOpen(true);
        return;
      }
      void runDetection(paramsRef.current);
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [params, page, busy, runDetection]);

  function resetPageState() {
    detectTokenRef.current += 1;
    submitRunRef.current += 1;
    submitCancelRef.current = true;
    submitStopRef.current = false;
    segmenterRef.current?.dispose();
    segmenterRef.current = null;
    retireBitmap(bitmapRef.current);
    bitmapRef.current = null;
    fileRef.current = null;

    setPage(null);
    setPageVersion((version) => version + 1);
    setLines([]);
    setDetectedBoxes([]);
    setHistory([]);
    setSelected(0);
    setCurrentLine(0);
    setSplitIndex(null);
    setParams(DEFAULT_PARAMS);
    appliedParamsRef.current = DEFAULT_PARAMS;
    setFileName(null);
    setFileSize(0);
    setOriginalSize(null);
    setPageLabel("");
    setRights(false);
    setStep("review");
    setLineNotice(null);
    setSaveState(null);
    setSubmission(null);
    submissionRef.current = null;
    preparedRef.current = null;
    setSubmitState({ kind: "idle" });
    setSubmitSuccess(null);
    setSubmitNotice(null);
    currentLineRef.current = 0;
    pageLabelRef.current = "";
    rightsRef.current = false;
  }

  async function processFile(file: File) {
    const invalid = validatePageFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }

    setDraftActionError(null);
    setResumeMessage("");
    const token = ++loadTokenRef.current;
    detectTokenRef.current++;
    setBusy("load");
    setError(null);
    setProgress("Decoding the page");

    let bitmap: ImageBitmap;
    try {
      bitmap = await decodePageFile(file);
    } catch (caught) {
      if (!mountedRef.current || token !== loadTokenRef.current) return;
      setBusy(null);
      setProgress("");
      setError(
        segmenterErrorMessage(
          caught,
          "That image could not be opened. Try another file.",
        ),
      );
      return;
    }

    if (!mountedRef.current || token !== loadTokenRef.current) {
      bitmap.close();
      return;
    }

    const sourceSize = { width: bitmap.width, height: bitmap.height };
    resetPageState();
    setFileName(file.name);
    setFileSize(file.size);
    setOriginalSize(sourceSize);
    fileRef.current = file;
    setSavedDraft(null);
    setDialog(null);
    setPendingFile(null);

    let segmenter: PageSegmenter;
    try {
      segmenter = new PageSegmenter();
    } catch (caught) {
      bitmap.close();
      setBusy(null);
      setProgress("");
      setError(
        segmenterErrorMessage(
          caught,
          "This browser cannot run in-browser line detection.",
        ),
      );
      return;
    }

    segmenterRef.current = segmenter;
    segmenter.onProgress = (message) => {
      if (mountedRef.current && token === loadTokenRef.current) {
        setProgress(message);
      }
    };

    try {
      const result = await segmenter.load(bitmap, DEFAULT_PARAMS);
      if (!mountedRef.current || token !== loadTokenRef.current) {
        result.bitmap?.close();
        segmenter.dispose();
        return;
      }
      if (!result.bitmap || !isBitmapUsable(result.bitmap)) {
        result.bitmap?.close();
        setBusy(null);
        setProgress("");
        setError("The page preview could not be created. Try another image.");
        segmenter.dispose();
        if (segmenterRef.current === segmenter) segmenterRef.current = null;
        return;
      }
      applyDetection(result, []);
      setBusy(null);
      setProgress("");
    } catch (caught) {
      if (!mountedRef.current || token !== loadTokenRef.current) return;
      setBusy(null);
      setProgress("");
      setError(
        segmenterErrorMessage(
          caught,
          "The page could not be processed. Try another image.",
        ),
      );
      segmenter.dispose();
      if (segmenterRef.current === segmenter) segmenterRef.current = null;
    }
  }

  function currentSubmitContext(): SubmitContext {
    return {
      lines: linesRef.current,
      label: pageLabelRef.current,
      rights: rightsRef.current,
      fileName: fileName ?? "",
      submission: submissionRef.current,
    };
  }

  async function persistDraftSubmission(
    context: SubmitContext,
    record: OcrSubmission | null,
  ): Promise<void> {
    const file = fileRef.current;
    if (!file || !context.fileName) return;

    await writeOcrDraft(userId, {
      file,
      fileName: context.fileName,
      params: paramsRef.current,
      boxes: context.lines.map((line) => line.box),
      lines: [...context.lines],
      currentLine: currentLineRef.current,
      pageLabel: context.label,
      rightsConfirmed: context.rights,
      submission: record,
    });
  }

  /**
   * Clear the local draft only when it still belongs to the page that was just
   * finalized. A newer draft, for example one created after navigating away,
   * is left alone.
   */
  async function clearDraftForPage(pageId: string): Promise<boolean> {
    try {
      const stored = await readOcrDraft(userId);
      if (stored && stored.submission?.pageId !== pageId) return false;
      await deleteOcrDraft(userId);
      return true;
    } catch {
      return false;
    }
  }

  function submissionHalted(): boolean {
    return submitCancelRef.current || submitStopRef.current;
  }

  async function prepareImages(
    context: SubmitContext,
    run: number,
  ): Promise<PreparedImage[]> {
    const bitmap = bitmapRef.current;
    if (!bitmap || !isBitmapUsable(bitmap)) {
      throw new Error(
        "The page image is no longer available. Reload the page, then try again.",
      );
    }

    const targets = context.lines
      .map((line, index) => ({ line, idx: index + 1 }))
      .filter(
        ({ line }) =>
          line.status !== "unreadable" && normalizeLabel(line.label) !== "",
      );

    setSubmitState({ kind: "preparing", done: 0, total: targets.length });
    const prepared: PreparedImage[] = [];

    for (const target of targets) {
      if (run !== submitRunRef.current || submissionHalted()) {
        throw new SubmissionHalted();
      }

      const encoded = await encodeLine(cropToCanvas(bitmap, target.line.box));
      prepared.push({
        idx: target.idx,
        label: normalizeLabel(target.line.label),
        blob: encoded.blob,
        type: encoded.type,
        extension: encoded.extension,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.bytes,
      });

      if (run !== submitRunRef.current) throw new SubmissionHalted();
      setSubmitState({
        kind: "preparing",
        done: prepared.length,
        total: targets.length,
      });
      await yieldToUi();
    }

    return prepared;
  }

  function preparedPlan(
    context: SubmitContext,
    prepared: readonly PreparedImage[],
    pageId: string,
  ): PreparedLine[] {
    const byIndex = new Map(prepared.map((line) => [line.idx, line]));
    const base = buildUploadPlan(context.lines, userId, pageId, "webp");

    return base.map((item) => {
      const image = byIndex.get(item.idx);
      if (!image) {
        throw new Error(
          "A line image was missing from the upload. Retry the submission.",
        );
      }

      return {
        idx: item.idx,
        label: item.label,
        storage_path: `${userId}/${pageId}/${item.idx}.${image.extension}`,
        blob: image.blob,
        type: image.type,
        width: image.width,
        height: image.height,
        bytes: image.bytes,
      };
    });
  }

  function finalizePrepared(pageId: string, plan: readonly PreparedLine[]) {
    return finalizeOcrPage({
      pageId,
      lines: plan.map((line) => ({
        idx: line.idx,
        storagePath: line.storage_path,
        label: line.label,
        width: line.width,
        height: line.height,
        bytes: line.bytes,
      })),
    });
  }

  async function finishHalted(
    pageId: string | null,
    context: SubmitContext,
    total: number,
    uploadedCount: number,
  ): Promise<void> {
    if (submitCancelRef.current) {
      if (pageId) {
        const aborted = await abortOcrPage(pageId);
        if (!aborted.ok) {
          setSubmitState({
            kind: "error",
            stage: "upload",
            message:
              "The unfinished page could not be closed on the server. Retry the cancellation, or reload the page.",
          });
          return;
        }
      }

      setSubmission(null);
      submissionRef.current = null;
      preparedRef.current = null;
      try {
        await persistDraftSubmission(context, null);
      } catch {
        // The remote page is closed. A stale local record would only retry a
        // failed page, and the server refuses that.
      }
      setSubmitState({ kind: "idle" });
      setStep("label");
      setSubmitNotice(
        "Submission cancelled. Your labels are still in this browser.",
      );
      router.refresh();
      return;
    }

    if (!pageId) {
      setSubmitState({ kind: "idle" });
      setStep("label");
      setSubmitNotice("Submission stopped. Your labels are still in this browser.");
      return;
    }

    setSubmitState({ kind: "idle" });
    setStep("submit");
    setSubmitNotice(
      total > 0
        ? `Upload stopped at ${uploadedCount} of ${total} lines. Resume when you are ready.`
        : "Upload stopped. Resume when you are ready.",
    );
    router.refresh();
  }

  async function runSubmission(context: SubmitContext): Promise<void> {
    if (submitActiveRef.current) return;
    submitActiveRef.current = true;

    try {
      await runSubmissionRun(context);
    } finally {
      submitActiveRef.current = false;
    }
  }

  async function runSubmissionRun(context: SubmitContext): Promise<void> {
    if (isSubmitting) return;

    const run = ++submitRunRef.current;
    submitCancelRef.current = false;
    submitStopRef.current = false;
    setSubmitNotice(null);
    setSubmitSuccess(null);

    const check = submitGate(context.lines, context.rights);
    if (!check.canSubmit) {
      setSubmitState({
        kind: "error",
        stage: "prepare",
        message: check.reason ?? "This page cannot be submitted yet.",
      });
      return;
    }

    let pageId = context.submission?.pageId ?? null;
    const uploaded = new Set(context.submission?.uploadedIdx ?? []);
    let total = 0;
    let stage: "prepare" | "create" | "upload" | "finalize" = "prepare";

    try {
      let prepared = context.submission ? preparedRef.current : null;
      if (!prepared) {
        prepared = await prepareImages(context, run);
        preparedRef.current = prepared;
      }

      if (prepared.length < 1) {
        throw new Error("Add at least one line label before you submit.");
      }
      total = prepared.length;

      if (!pageId) {
        stage = "create";
        setSubmitState({ kind: "creating" });
        const totalBytes = prepared.reduce((sum, line) => sum + line.bytes, 0);
        const created = await createOcrPage({
          label: context.label.trim(),
          rights: context.rights,
          lineCount: context.lines.length,
          totalBytes,
        });

        if (run !== submitRunRef.current) {
          // The page was reserved after this run was abandoned. Close it so a
          // replaced or unmounted page does not stay Incomplete.
          if (created.status === "created") void abortOcrPage(created.pageId);
          return;
        }
        if (created.status === "error") {
          setSubmitState({
            kind: "error",
            stage: "create",
            message: created.message,
          });
          return;
        }

        pageId = created.pageId;
        uploaded.clear();
        const record: OcrSubmission = { pageId, uploadedIdx: [] };
        setSubmission(record);
        submissionRef.current = record;
        try {
          await persistDraftSubmission(context, record);
        } catch {
          // Upload continues. If the record was lost, a later resume uploads
          // the same paths again with upsert.
        }
      }

      if (submissionHalted()) {
        await finishHalted(pageId, context, total, uploaded.size);
        return;
      }

      const activePageId = pageId;
      const plan = preparedPlan(context, prepared, activePageId);
      total = plan.length;
      const byIndex = new Map(prepared.map((line) => [line.idx, line]));
      const pending = plan.filter((line) => !uploaded.has(line.idx));
      let done = uploaded.size;
      stage = "upload";

      const supabase = createClient();
      let failure: unknown = null;
      let next = 0;

      const uploadOne = async () => {
        while (!failure && !submissionHalted()) {
          const position = next;
          next += 1;
          if (position >= pending.length) return;

          const line = pending[position];
          const image = byIndex.get(line.idx);
          if (!image) {
            failure = new Error(
              "A line image was missing from the upload. Retry the submission.",
            );
            return;
          }

          try {
            await uploadWithRetry(supabase, {
              idx: line.idx,
              label: line.label,
              storage_path: line.storage_path,
              blob: image.blob,
              type: image.type,
              width: image.width,
              height: image.height,
              bytes: image.bytes,
            });
          } catch (caught) {
            failure = caught;
            logOcrSubmitError(
              caught as { message?: unknown; code?: unknown },
            );
            return;
          }

          if (run !== submitRunRef.current) return;
          uploaded.add(line.idx);
          done += 1;
          const record: OcrSubmission = {
            pageId: activePageId,
            uploadedIdx: [...uploaded].sort((a, b) => a - b),
          };
          setSubmission(record);
          submissionRef.current = record;
          if (mountedRef.current && !submissionHalted()) {
            setSubmitState({
              kind: "uploading",
              done,
              total: plan.length,
            });
          }
          try {
            await persistDraftSubmission(context, record);
          } catch {
            // The encoded lines are still in memory, and a retry upserts the
            // same paths.
          }
        }
      };

      if (pending.length > 0) {
        setSubmitState({ kind: "uploading", done, total: plan.length });
        const workers = Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, pending.length) },
          () => uploadOne(),
        );
        await Promise.all(workers);
      }

      if (run !== submitRunRef.current) return;
      if (failure) throw failure;
      if (submissionHalted()) {
        await finishHalted(pageId, context, total, uploaded.size);
        return;
      }

      stage = "finalize";
      setSubmitState({ kind: "finalizing" });
      const finalized = await finalizePrepared(activePageId, plan);
      if (run !== submitRunRef.current) return;

      if (finalized.status !== "finalized") {
        setSubmitState({
          kind: "error",
          stage: "finalize",
          message: finalized.message,
        });
        return;
      }

      saveTokenRef.current += 1;
      if (mountedRef.current) {
        setSubmission(null);
        submissionRef.current = null;
        preparedRef.current = null;
        setSubmitState({ kind: "idle" });
        setSubmitSuccess({ lineCount: finalized.lineCount });
        setSubmitNotice(null);
        setStep("submit");
      }

      const cleared = await clearDraftForPage(activePageId);
      if (mountedRef.current) {
        if (cleared) setSavedDraft(null);
        router.refresh();
      }
    } catch (caught) {
      if (run !== submitRunRef.current) return;
      if (caught instanceof SubmissionHalted) {
        await finishHalted(pageId, context, total, uploaded.size);
        return;
      }

      logOcrSubmitError(caught as { message?: unknown; code?: unknown });
      setSubmitState({
        kind: "error",
        stage,
        message: errorMessageOf(
          caught,
          "The page could not be submitted. Your labels are still in this browser.",
        ),
      });
    }
  }

  function retrySubmission() {
    if (isSubmitting) return;
    void runSubmission(currentSubmitContext());
  }

  function stopUpload() {
    if (submitState.kind !== "uploading") return;
    submitStopRef.current = true;
    submitCancelRef.current = false;
    setSubmitState({ kind: "stopping" });
  }

  async function cancelSubmission(): Promise<void> {
    if (isSubmitting && submitState.kind === "finalizing") return;
    if (submitState.kind === "cancelling") return;

    submitCancelRef.current = true;
    submitStopRef.current = false;

    if (
      submitState.kind === "preparing" ||
      submitState.kind === "creating" ||
      submitState.kind === "uploading" ||
      submitState.kind === "stopping"
    ) {
      setSubmitState({ kind: "cancelling" });
      return;
    }

    setSubmitState({ kind: "cancelling" });
    const context = currentSubmitContext();
    const current = submissionRef.current;

    if (current) {
      const aborted = await abortOcrPage(current.pageId);
      if (!aborted.ok) {
        setSubmitState({
          kind: "error",
          stage: "upload",
          message:
            "The unfinished page could not be closed on the server. Retry, or reload the page.",
        });
        return;
      }
    }

    setSubmission(null);
    submissionRef.current = null;
    preparedRef.current = null;
    try {
      await persistDraftSubmission(context, null);
    } catch {
      // The remote page is closed. The next save replaces the local record.
    }
    setSubmitState({ kind: "idle" });
    setStep("label");
    setSubmitNotice("Submission cancelled. Your labels are still in this browser.");
    router.refresh();
  }

  function backToLabeling() {
    if (submissionRef.current) return;
    submitCancelRef.current = false;
    submitStopRef.current = false;
    setSubmitState({ kind: "idle" });
    setSubmitNotice(null);
    setStep("label");
  }

  function startAnotherPage() {
    setSubmitSuccess(null);
    setSubmitNotice(null);
    resetPageState();
  }

  function confirmSubmit() {
    setDialog(null);
    void runSubmission(currentSubmitContext());
  }

  async function resumeDraft(draft: OcrDraft, continueUpload = false) {
    if (draftBusy !== null) return;

    const token = ++loadTokenRef.current;
    detectTokenRef.current++;
    setDraftBusy("resume");
    setDraftActionError(null);
    setResumeMessage("Opening the saved page");

    let bitmap: ImageBitmap;
    try {
      bitmap = await decodePageFile(draft.file);
    } catch (caught) {
      if (!mountedRef.current || token !== loadTokenRef.current) return;
      setDraftBusy(null);
      setResumeMessage("");
      setDraftActionError(
        segmenterErrorMessage(
          caught,
          "The saved page image could not be opened. Try another page, or discard this draft.",
        ),
      );
      return;
    }

    if (!mountedRef.current || token !== loadTokenRef.current) {
      bitmap.close();
      return;
    }

    const sourceSize = { width: bitmap.width, height: bitmap.height };

    let segmenter: PageSegmenter;
    try {
      segmenter = new PageSegmenter();
    } catch (caught) {
      bitmap.close();
      setDraftBusy(null);
      setResumeMessage("");
      setDraftActionError(
        segmenterErrorMessage(
          caught,
          "This browser cannot open the saved page for line review.",
        ),
      );
      return;
    }

    segmenter.onProgress = (message) => {
      if (mountedRef.current && token === loadTokenRef.current) {
        setResumeMessage(message);
      }
    };

    try {
      const result = await segmenter.load(bitmap, draft.params);
      if (!mountedRef.current || token !== loadTokenRef.current) {
        result.bitmap?.close();
        segmenter.dispose();
        return;
      }
      if (!result.bitmap || !isBitmapUsable(result.bitmap)) {
        result.bitmap?.close();
        segmenter.dispose();
        setDraftBusy(null);
        setResumeMessage("");
        setDraftActionError(
          "The saved page preview could not be created. Try again, or discard this draft.",
        );
        return;
      }

      const restored = draft.lines.map((line) => ({
        ...line,
        box: clampBox(line.box, result.width, result.height),
      }));
      const restoredCurrent = Math.min(
        Math.max(0, draft.currentLine),
        Math.max(0, restored.length - 1),
      );
      const hasProgress = restored.some((line) => line.status !== "empty");
      const canLabel = restored.length >= 1 && restored.length <= 40;

      segmenterRef.current?.dispose();
      retireBitmap(bitmapRef.current);

      segmenterRef.current = segmenter;
      bitmapRef.current = result.bitmap;
      appliedParamsRef.current = draft.params;
      paramsRef.current = draft.params;
      linesRef.current = restored;
      currentLineRef.current = restoredCurrent;
      pageLabelRef.current = draft.pageLabel;
      rightsRef.current = draft.rightsConfirmed;
      setParams(draft.params);
      setLines(restored);
      setDetectedBoxes(result.boxes);
      setHistory([]);
      setSelected(restoredCurrent);
      setCurrentLine(restoredCurrent);
      setSplitIndex(null);
      setPage({
        bitmap: result.bitmap,
        width: result.width,
        height: result.height,
        angle: result.angle,
      });
      setPageVersion((version) => version + 1);
      setFileName(draft.fileName);
      setFileSize(draft.file.size);
      setOriginalSize(sourceSize);
      fileRef.current = draft.file;
      setPageLabel(draft.pageLabel);
      setRights(draft.rightsConfirmed);
      setSubmission(draft.submission);
      submissionRef.current = draft.submission;
      preparedRef.current = null;
      setSubmitState({ kind: "idle" });
      setSubmitNotice(null);
      setSubmitSuccess(null);
      setStep(
        draft.submission
          ? "submit"
          : hasProgress && canLabel
            ? "label"
            : "review",
      );
      setLineNotice(null);
      setSaveState({ kind: "saved", at: draft.updatedAt });
      setSavedDraft(null);
      setDraftBusy(null);
      setResumeMessage("");
      setDraftActionError(null);

      if (draft.submission && continueUpload) {
        void runSubmission({
          lines: restored,
          rights: draft.rightsConfirmed,
          label: draft.pageLabel,
          fileName: draft.fileName,
          submission: draft.submission,
        });
      }
    } catch (caught) {
      segmenter.dispose();
      if (!mountedRef.current || token !== loadTokenRef.current) return;
      setDraftBusy(null);
      setResumeMessage("");
      setDraftActionError(
        segmenterErrorMessage(
          caught,
          "The saved page could not be restored. Try again, or discard this draft.",
        ),
      );
    }
  }

  async function discardDraft() {
    if (draftBusy !== null || isSubmitting) return;
    setDialog(null);
    setDraftBusy("discard");
    setDraftActionError(null);

    const unfinished = savedDraft?.submission ?? null;
    if (unfinished) {
      const aborted = await abortOcrPage(unfinished.pageId);
      if (!aborted.ok) {
        if (!mountedRef.current) return;
        setDraftBusy(null);
        setDraftActionError(
          "The unfinished page could not be closed on the server. Reload the page and try again.",
        );
        return;
      }
    }

    try {
      await deleteOcrDraft(userId);
      if (!mountedRef.current) return;
      saveTokenRef.current += 1;
      setSavedDraft(null);
      resetPageState();
      setDraftBusy(null);
    } catch (caught) {
      if (!mountedRef.current) return;
      setDraftBusy(null);
      setDraftActionError(draftStoreMessage(caught));
    }
  }

  function confirmNewPage() {
    const file = pendingFile;
    setDialog(null);
    setPendingFile(null);
    if (file) void processFile(file);
  }

  function requestFile(file: File) {
    if (isSubmitting) return;

    if (submissionRef.current) {
      setStep("submit");
      setSubmitNotice(
        "Finish or cancel the current submission before you start a new page.",
      );
      return;
    }

    const invalid = validatePageFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }

    if (page || savedDraft) {
      setPendingFile(file);
      setDialog("new-page");
      return;
    }

    void processFile(file);
  }

  function openPicker() {
    if (isSubmitting) return;
    fileInputRef.current?.click();
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) requestFile(file);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragActive(false);
    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      setError("Choose one page image at a time.");
      return;
    }
    const file = files[0];
    if (file) requestFile(file);
  }

  function pushHistory() {
    const snapshot: HistoryEntry = {
      lines: cloneLines(lines),
      selected,
      current: currentLine,
    };
    setHistory((current) => [...current, snapshot].slice(-HISTORY_LIMIT));
  }

  function applyEdit(
    nextLines: LineDraft[],
    nextSelected: number,
    nextCurrent: number,
    resetLabels: boolean,
  ) {
    pushHistory();
    setLines(nextLines);
    setSelected(Math.max(0, Math.min(nextSelected, nextLines.length - 1)));
    setCurrentLine(
      Math.max(0, Math.min(nextCurrent, Math.max(0, nextLines.length - 1))),
    );
    setSplitIndex(null);
    if (resetLabels) setLineNotice(RESET_NOTICE);
  }

  function selectLine(index: number) {
    setSelected(index);
    setSplitIndex(null);
  }

  function deleteLine(index: number) {
    if (!page || busy !== null) return;
    const removed = lines[index];
    if (!removed) return;

    const next = lines.filter((_, current) => current !== index);
    const nextSelected = Math.min(
      index < selected ? selected - 1 : selected,
      Math.max(0, next.length - 1),
    );
    let nextCurrent = currentLine;
    if (index < currentLine) nextCurrent = Math.max(0, currentLine - 1);
    else if (index === currentLine) {
      nextCurrent = Math.min(currentLine, Math.max(0, next.length - 1));
    }

    applyEdit(next, nextSelected, nextCurrent, removed.status !== "empty");
  }

  function mergeWithNext(index: number) {
    if (!page || busy !== null) return;
    const first = lines[index];
    const second = lines[index + 1];
    if (!first || !second) return;

    const y0 = first.box[1];
    const y1 = second.box[3];
    const extent = trimHorizontally(page.bitmap, y0, y1, params.pad);
    const merged: LineBox = extent
      ? [extent.x0, y0, extent.x1, y1]
      : [
          Math.min(first.box[0], second.box[0]),
          y0,
          Math.max(first.box[2], second.box[2]),
          y1,
        ];

    const next = [...lines];
    next.splice(index, 2, makeLine(merged));
    let nextCurrent = currentLine;
    if (currentLine > index + 1) nextCurrent = currentLine - 1;
    else if (currentLine >= index) nextCurrent = index;

    applyEdit(
      next,
      index,
      nextCurrent,
      first.status !== "empty" || second.status !== "empty",
    );
  }

  function startSplit(index: number) {
    const box = lines[index]?.box;
    if (!box || busy !== null) return;
    if (box[3] - box[1] < 4) return;
    setSelected(index);
    setSplitIndex(index);
    setSplitY(Math.round((box[1] + box[3]) / 2));
  }

  function splitAt(index: number, y: number) {
    if (!page || busy !== null) return;
    const line = lines[index];
    if (!line) return;
    const box = line.box;
    const top = box[1];
    const bottom = box[3];
    if (bottom - top < 4) return;

    const split = Math.round(Math.min(bottom - 1, Math.max(top + 1, y)));
    const topExtent = trimHorizontally(page.bitmap, top, split, params.pad);
    const bottomExtent = trimHorizontally(
      page.bitmap,
      split,
      bottom,
      params.pad,
    );

    const topBox: LineBox = [
      topExtent ? topExtent.x0 : box[0],
      top,
      topExtent ? topExtent.x1 : box[2],
      split,
    ];
    const bottomBox: LineBox = [
      bottomExtent ? bottomExtent.x0 : box[0],
      split,
      bottomExtent ? bottomExtent.x1 : box[2],
      bottom,
    ];

    const next = [...lines];
    next.splice(index, 1, makeLine(topBox), makeLine(bottomBox));
    const nextCurrent = currentLine > index ? currentLine + 1 : currentLine;

    applyEdit(next, index, nextCurrent, line.status !== "empty");
  }

  function undo() {
    if (busy !== null) return;
    const entry = history[history.length - 1];
    if (!entry) return;

    // Labels typed after an edit are newer than the history snapshot. Keep
    // them for every id that survives the undo.
    const currentById = new Map(lines.map((line) => [line.id, line]));
    const restored = entry.lines.map((line) => {
      const current = currentById.get(line.id);
      return current
        ? { ...line, label: current.label, status: current.status }
        : line;
    });

    setHistory((current) => current.slice(0, -1));
    setLines(restored);
    setSelected(Math.max(0, Math.min(entry.selected, entry.lines.length - 1)));
    setCurrentLine(
      Math.max(0, Math.min(entry.current, Math.max(0, entry.lines.length - 1))),
    );
    setSplitIndex(null);
    setLineNotice(null);
  }

  function confirmRedetect() {
    setConfirmOpen(false);
    if (!segParamsEqual(paramsRef.current, appliedParamsRef.current)) {
      void runDetection(paramsRef.current);
    }
  }

  function cancelRedetect() {
    setConfirmOpen(false);
    setParams(appliedParamsRef.current);
  }

  function changeLineLabel(index: number, value: string) {
    setLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index
          ? { ...line, label: value, status: statusForLabel(value) }
          : line,
      ),
    );
  }

  function toggleUnreadable(index: number) {
    setLines((current) =>
      current.map((line, lineIndex) => {
        if (lineIndex !== index) return line;
        return {
          ...line,
          status:
            line.status === "unreadable"
              ? statusForLabel(line.label)
              : "unreadable",
        };
      }),
    );
  }

  function clearLine(index: number) {
    setLines((current) =>
      current.map((line, lineIndex) =>
        lineIndex === index
          ? { ...line, label: "", status: "empty" }
          : line,
      ),
    );
  }

  function startLabeling() {
    if (lines.length < 1 || lines.length > 40) return;
    const firstEmpty = lines.findIndex((line) => line.status === "empty");
    setCurrentLine(
      firstEmpty >= 0
        ? firstEmpty
        : Math.min(currentLine, Math.max(0, lines.length - 1)),
    );
    setLineNotice(null);
    setStep("label");
  }

  function backToLines() {
    setSelected(
      Math.min(currentLine, Math.max(0, lines.length - 1)),
    );
    setStep("review");
  }

  const saveText = submitSuccess
    ? "Local draft cleared after submit"
    : page
      ? draftStorageMessage
        ? `Could not save. ${draftStorageMessage}`
        : saveState?.kind === "saved"
          ? `Saved in this browser at ${formatClock(saveState.at)}`
          : saveState?.kind === "error"
            ? `Could not save. ${saveState.message}`
            : saveState?.kind === "saving"
              ? "Saving in this browser..."
              : "Preparing the local draft..."
      : draftStorageMessage ?? "";

  const currentPageSaved =
    saveState?.kind === "saved" || saveState?.kind === "saving";
  const newPageBody = savedDraft
    ? "A saved draft already exists in this browser. Starting a new page replaces it, and the saved labels will be deleted. This cannot be undone."
    : currentPageSaved
      ? "This replaces the page saved in this browser. Its image and labels will be deleted. This cannot be undone."
      : "The current page and any unsaved labels will be lost. This cannot be undone.";

  const submitProgress =
    submitState.kind === "preparing" || submitState.kind === "uploading"
      ? {
          done: submitState.done,
          total: submitState.total,
          label:
            submitState.kind === "preparing"
              ? "Preparing line images"
              : "Uploading line images",
        }
      : null;
  const resumeUploaded = submission?.uploadedIdx.length ?? 0;
  const resumeTotal = Math.max(gate.labeled, resumeUploaded);
  const canLeaveSubmit = submission === null && !isSubmitting;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <StepIndicator step={step} hasPage={page !== null} />
        <p
          role="status"
          aria-live="polite"
          className={cn(
            "max-w-[46ch] text-caption",
            saveText.startsWith("Could not save") ||
              (draftStorageMessage && !page)
              ? "text-error"
              : "text-mute",
          )}
        >
          {saveText}
        </p>
      </div>

      {quotaDecision === "warn" ? (
        <p
          role="status"
          className="mt-4 rounded-md bg-surface px-3 py-2 text-body-sm text-ink shadow-elev-1"
        >
          OCR storage is at or above 60 percent. Uploads still work, but the
          quota is filling.
        </p>
      ) : null}

      {quotaBlocked ? (
        <p
          role="status"
          className="mt-4 rounded-md bg-surface px-3 py-2 text-body-sm text-ink shadow-elev-1"
        >
          OCR uploads are paused because storage is above 80 percent. Plain
          text, instructions and conversations are still open.
        </p>
      ) : null}

      {submitNotice ? (
        <p
          role="status"
          className="mt-4 rounded-md bg-surface px-3 py-2 text-body-sm text-ink shadow-elev-1"
        >
          {submitNotice}
        </p>
      ) : null}

      {error && step === "review" ? (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface px-3 py-2 text-body-sm text-error shadow-elev-1"
        >
          <p>{error}</p>
          {page && !isBitmapUsable(page.bitmap) ? (
            <Button
              type="button"
              variant="secondary"
              className="h-11 sm:h-10"
              onClick={() => window.location.reload()}
            >
              Reload page
            </Button>
          ) : null}
        </div>
      ) : null}

      {recovering ? (
        <p
          role="status"
          className="mt-4 rounded-md bg-surface px-3 py-2 text-body-sm text-ink shadow-elev-1"
        >
          Reloading your page...
        </p>
      ) : null}

      {busy === "load" && page ? (
        <p
          role="status"
          className="mt-4 rounded-md bg-surface px-3 py-2 text-body-sm text-ink shadow-elev-1"
        >
          {progress || "Reading the new page"}
        </p>
      ) : null}

      <ConfirmDialog
        open={dialog !== null}
        title={
          dialog === "discard-draft"
            ? "Discard this draft?"
            : dialog === "submit"
              ? "Submit this page?"
              : "Start a new page?"
        }
        body={
          dialog === "discard-draft"
            ? "The saved page image and its labels will be deleted from this browser. This cannot be undone."
            : dialog === "submit"
              ? undefined
              : newPageBody
        }
        confirmLabel={
          dialog === "discard-draft"
            ? "Discard draft"
            : dialog === "submit"
              ? "Submit page"
              : "Start new page"
        }
        cancelLabel={
          dialog === "discard-draft"
            ? "Keep draft"
            : dialog === "submit"
              ? "Keep editing"
              : "Cancel"
        }
        onConfirm={() => {
          if (dialog === "discard-draft") void discardDraft();
          else if (dialog === "submit") confirmSubmit();
          else void confirmNewPage();
        }}
        onCancel={() => {
          setDialog(null);
          setPendingFile(null);
        }}
      >
        {dialog === "submit" ? (
          <>
            <p>
              {effectiveGate.labeled === 1
                ? "This uploads 1 line image and its label."
                : `This uploads ${effectiveGate.labeled} line images and labels.`}
            </p>
            {effectiveGate.unreadable > 0 ? (
              <p className="mt-2">
                {effectiveGate.unreadable === 1
                  ? "1 unreadable line is skipped."
                  : `${effectiveGate.unreadable} unreadable lines are skipped.`}
              </p>
            ) : null}
            <p className="mt-2">
              The original page image stays in this browser.
            </p>
          </>
        ) : null}
      </ConfirmDialog>

      {draftCheck === "checking" ? <DraftCheckCard /> : null}

      {draftCheck === "ready" && step === "review" ? (
        <>
          {savedDraft && !page && busy !== "load" ? (
            <ResumeCard
              draft={savedDraft}
              busy={draftBusy}
              message={resumeMessage}
              error={draftActionError}
              onResume={() =>
                void resumeDraft(savedDraft, savedDraft.submission !== null)
              }
              onDiscard={() => {
                setDraftActionError(null);
                setDialog("discard-draft");
              }}
            />
          ) : busy === "load" && !page ? null : (
            <Card className="mt-4 p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-display-sm font-semibold text-ink">
                    {page ? "Page ready" : "Upload a page"}
                  </h2>
                  <p className="mt-1 max-w-[65ch] text-body-sm text-body">
                    {page
                      ? "Check the detected lines, delete or merge anything that is wrong, then continue to labeling."
                      : "One page image at a time. Line detection runs in a Worker in this browser, and you can fix the detected lines before labeling."}
                  </p>
                </div>
                {page ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11 sm:h-10"
                    onClick={openPicker}
                    disabled={busy === "load"}
                  >
                    Replace
                  </Button>
                ) : null}
              </div>

              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={handleInputChange}
              />

              {fileName ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-body-sm font-medium text-ink">
                      {fileName}
                    </p>
                    <p className="text-caption tabular-nums text-mute">
                      {formatBytes(fileSize)}
                      {originalSize
                        ? `, ${originalSize.width.toLocaleString("en")} x ${originalSize.height.toLocaleString("en")} px`
                        : ""}
                    </p>
                  </div>
                  {!page && busy === "load" ? (
                    <span role="status" className="text-caption text-mute">
                      Reading the page
                    </span>
                  ) : null}
                </div>
              ) : null}

              {!page ? (
                <button
                  type="button"
                  onClick={openPicker}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragLeave={(event) => {
                    if (
                      event.currentTarget.contains(
                        event.relatedTarget as Node,
                      )
                    ) {
                      return;
                    }
                    setDragActive(false);
                  }}
                  onDrop={handleDrop}
                  aria-describedby="ocr-file-help"
                  className={cn(
                    "mt-4 flex min-h-[200px] w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center",
                    "transition-colors duration-150 ease-[var(--ease-out-quart)]",
                    dragActive
                      ? "border-accent bg-accent-soft"
                      : "border-hairline-strong bg-surface-2 hover:brightness-105",
                  )}
                >
                  <UploadSimple
                    size={28}
                    weight="light"
                    aria-hidden="true"
                    className="text-mute"
                  />
                  <span className="text-body-md font-medium text-ink">
                    {dragActive
                      ? "Drop the page here"
                      : "Drop a page image here, or choose a file"}
                  </span>
                  <span
                    id="ocr-file-help"
                    className="max-w-[46ch] text-caption text-mute"
                  >
                    JPG, PNG or WebP up to 15 MB. The long edge must be between
                    600 and 10,000 px.
                  </span>
                </button>
              ) : null}

              {draftStorageMessage ? (
                <p className="mt-3 text-caption text-error">
                  {draftStorageMessage}
                </p>
              ) : null}

              <p className="mt-3 text-caption text-mute">
                The page image and labels stay in this browser until you
                submit. The original image is never uploaded.
              </p>
            </Card>
          )}

          {busy === "load" && !page ? (
            <SegmentationSkeleton message={progress} />
          ) : null}

          {page ? (
            <>
              {lineNotice ? (
                <p
                  role="status"
                  className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-body-sm text-accent-text"
                >
                  {lineNotice}
                </p>
              ) : null}

              <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start xl:grid-cols-[minmax(0,1fr)_400px]">
                <OcrErrorBoundary
                  key={`preview-${pageVersion}`}
                  label="The page preview could not be drawn"
                >
                  <PagePreview
                    key={pageVersion}
                    page={page}
                    boxes={boxes}
                    selected={selected}
                    splitIndex={splitIndex}
                    onSelect={selectLine}
                    onSplitPick={splitAt}
                  />
                </OcrErrorBoundary>

                <div className="flex min-w-0 flex-col gap-4">
                  <DetectionPanel
                    page={page}
                    originalSize={originalSize}
                    params={params}
                    onParamsChange={setParams}
                    onReset={() => setParams(DEFAULT_PARAMS)}
                    busy={busy}
                    progress={progress}
                    confirmOpen={confirmOpen}
                    onConfirm={confirmRedetect}
                    onCancel={cancelRedetect}
                  />
                  <OcrErrorBoundary
                    key={`lines-${pageVersion}`}
                    label="The line previews could not be drawn"
                  >
                    <LinesPanel
                      page={page}
                      lines={lines}
                      selected={selected}
                      onSelect={selectLine}
                      onDelete={deleteLine}
                      onMerge={mergeWithNext}
                      onSplitStart={startSplit}
                      splitIndex={splitIndex}
                      splitY={splitY}
                      onSplitYChange={setSplitY}
                      onSplitAt={splitAt}
                      onCancelSplit={() => setSplitIndex(null)}
                      historyLength={history.length}
                      onUndo={undo}
                      busy={busy}
                      onContinue={startLabeling}
                    />
                  </OcrErrorBoundary>
                </div>
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {draftCheck === "ready" && step === "label" && page ? (
        <OcrErrorBoundary
          key={`label-${pageVersion}`}
          label="The line image could not be drawn"
        >
          <LabelingView
            page={page}
            lines={lines}
            current={currentLine}
            onCurrentChange={setCurrentLine}
            onLineChange={changeLineLabel}
            onToggleUnreadable={toggleUnreadable}
            onClearLine={clearLine}
            onBack={backToLines}
            pageLabel={pageLabel}
            onPageLabelChange={setPageLabel}
            rights={rights}
            onRightsChange={setRights}
            gate={effectiveGate}
            onContinue={() => {
              setSubmitNotice(null);
              setStep("submit");
            }}
          />
        </OcrErrorBoundary>
      ) : null}

      {draftCheck === "ready" && step === "submit" && page ? (
        <Card className="mt-4 p-4 sm:p-6" aria-labelledby="ocr-submit-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2
                id="ocr-submit-heading"
                className="text-display-sm font-semibold text-ink"
              >
                {submitSuccess ? "Page submitted" : "Submit this page"}
              </h2>
              <p className="mt-1 max-w-[65ch] text-body-sm text-body">
                {submitSuccess
                  ? "The page is on the server and your local draft has been cleared."
                  : "Check what will be uploaded. The original page image is never sent."}
              </p>
            </div>
            {!submitSuccess ? (
              <Button
                type="button"
                variant="secondary"
                className="h-11 sm:h-10"
                onClick={backToLabeling}
                disabled={!canLeaveSubmit}
              >
                Back to labeling
              </Button>
            ) : null}
          </div>

          {submitSuccess ? (
            <div
              role="status"
              className="mt-4 rounded-md bg-accent-soft px-4 py-4"
            >
              <p className="text-body-md font-medium text-ink">
                Page submitted. {submitSuccess.lineCount}{" "}
                {submitSuccess.lineCount === 1 ? "line" : "lines"} uploaded.
              </p>
              <p className="mt-1 text-body-sm text-body">
                It now appears in My pages with the Submitted status.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11 sm:h-10"
                  onClick={startAnotherPage}
                >
                  Start another page
                </Button>
                <a
                  href="#my-pages"
                  className={
                    buttonClasses({ variant: "secondary", size: "sm" }) +
                    " h-11 sm:h-10"
                  }
                >
                  View My pages
                </a>
              </div>
            </div>
          ) : null}

          {submitProgress ? (
            <div
              role="status"
              aria-live="polite"
              className="mt-4 rounded-md bg-surface-2 px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-body-sm">
                <span className="font-medium text-ink">
                  {submitProgress.label}
                </span>
                <span className="tabular-nums text-body">
                  {submitProgress.done} of {submitProgress.total}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={submitProgress.label}
                aria-valuemin={0}
                aria-valuemax={submitProgress.total}
                aria-valuenow={submitProgress.done}
                aria-valuetext={`${submitProgress.done} of ${submitProgress.total} line images`}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-200 ease-[var(--ease-out-quart)]"
                  style={{
                    width:
                      submitProgress.total === 0
                        ? "0%"
                        : `${Math.round(
                            (submitProgress.done / submitProgress.total) * 100,
                          )}%`,
                  }}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {submitState.kind === "uploading" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11 sm:h-10"
                    onClick={stopUpload}
                  >
                    Stop upload
                  </Button>
                ) : null}
                {submitState.kind !== "stopping" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="h-11 sm:h-10"
                    onClick={() => void cancelSubmission()}
                  >
                    Cancel submission
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {!submitSuccess && !submitProgress && isSubmitting ? (
            <p
              role="status"
              aria-live="polite"
              className="mt-4 rounded-md bg-surface-2 px-4 py-3 text-body-sm text-ink"
            >
              {submitState.kind === "creating"
                ? "Reserving the page"
                : submitState.kind === "finalizing"
                  ? "Saving the page. Keep this tab open."
                  : submitState.kind === "stopping"
                    ? "Stopping after the line images already in flight"
                    : submitState.kind === "cancelling"
                      ? "Cancelling the submission"
                      : "Preparing the upload"}
            </p>
          ) : null}

          {!submitSuccess && submitState.kind === "error" ? (
            <div
              role="alert"
              className="mt-4 rounded-md bg-surface px-4 py-4 shadow-elev-1"
            >
              <p className="text-body-sm text-error">{submitState.message}</p>
              {submission ? (
                <p className="mt-2 text-caption text-body">
                  Retry if this was temporary. To change a label, cancel the
                  submission first.
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11 sm:h-10"
                  onClick={retrySubmission}
                >
                  Retry submission
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 sm:h-10"
                  onClick={() => void cancelSubmission()}
                >
                  Cancel submission
                </Button>
              </div>
            </div>
          ) : null}

          {!submitSuccess &&
          submission &&
          submitState.kind === "idle" ? (
            <div className="mt-4 rounded-md bg-surface-2 px-4 py-4">
              <p className="text-body-md font-medium text-ink">
                Upload interrupted
              </p>
              <p className="mt-1 text-body-sm text-body">
                {resumeUploaded} of {resumeTotal} line images are uploaded.
                Resume to finish this page.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11 sm:h-10"
                  onClick={retrySubmission}
                >
                  Resume upload
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 sm:h-10"
                  onClick={() => void cancelSubmission()}
                >
                  Cancel submission
                </Button>
              </div>
            </div>
          ) : null}

          {!submitSuccess &&
          !isSubmitting &&
          submitState.kind === "idle" &&
          !submission ? (
            <>
              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div>
                  <dt className="text-caption text-mute">Page label</dt>
                  <dd className="break-words text-body-sm text-ink">
                    {pageLabel.trim() || "Untitled page"}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-mute">Lines to upload</dt>
                  <dd className="tabular-nums text-body-sm text-ink">
                    {effectiveGate.labeled}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-mute">Unreadable</dt>
                  <dd className="tabular-nums text-body-sm text-ink">
                    {effectiveGate.unreadable}
                  </dd>
                </div>
                <div>
                  <dt className="text-caption text-mute">Rights</dt>
                  <dd className="text-body-sm text-ink">
                    {rights ? "Confirmed" : "Not confirmed"}
                  </dd>
                </div>
              </dl>

              {!effectiveGate.canSubmit ? (
                <p
                  id="ocr-submit-page-reason"
                  className="mt-3 text-body-sm text-error"
                >
                  {effectiveGate.reason}
                </p>
              ) : (
                <p className="mt-3 text-body-sm text-body">
                  Only the line images and labels are uploaded. The page image
                  stays in this browser.
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="h-11 sm:h-10"
                  onClick={() => setDialog("submit")}
                  disabled={!effectiveGate.canSubmit}
                  aria-describedby={
                    effectiveGate.canSubmit
                      ? undefined
                      : "ocr-submit-page-reason"
                  }
                >
                  Submit page
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 sm:h-10"
                  onClick={backToLabeling}
                >
                  Back to labeling
                </Button>
              </div>
            </>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function StepIndicator({
  step,
  hasPage,
}: {
  step: Step;
  hasPage: boolean;
}) {
  const active = !hasPage
    ? 1
    : step === "submit"
      ? 4
      : step === "label"
        ? 3
        : 2;

  const numberClass = (index: number) =>
    cn(
      "inline-flex size-6 items-center justify-center rounded-full border text-caption",
      active === index
        ? "border-accent bg-accent text-on-accent"
        : index < active
          ? "border-accent bg-accent-soft text-accent-text"
          : "border-hairline text-mute",
    );

  return (
    <ol
      aria-label="Progress"
      className="flex flex-wrap items-start gap-x-5 gap-y-3 text-body-sm"
    >
      <li
        aria-current={active === 1 ? "step" : undefined}
        className="flex items-center gap-2"
      >
        <span aria-hidden="true" className={numberClass(1)}>
          1
        </span>
        <span className={active === 1 ? "text-ink" : "text-mute"}>Upload</span>
      </li>
      <li
        aria-current={active === 2 ? "step" : undefined}
        className="flex items-center gap-2"
      >
        <span aria-hidden="true" className={numberClass(2)}>
          2
        </span>
        <span className={active === 2 ? "text-ink" : "text-mute"}>
          Check lines
        </span>
      </li>
      <li
        aria-current={active === 3 ? "step" : undefined}
        className="flex items-center gap-2"
      >
        <span aria-hidden="true" className={numberClass(3)}>
          3
        </span>
        <span className={active === 3 ? "text-ink" : "text-mute"}>Label</span>
      </li>
      <li
        aria-current={active === 4 ? "step" : undefined}
        className="flex items-center gap-2"
      >
        <span aria-hidden="true" className={numberClass(4)}>
          4
        </span>
        <span className={active === 4 ? "text-ink" : "text-mute"}>Submit</span>
      </li>
    </ol>
  );
}

function DraftCheckCard() {
  return (
    <Card className="mt-4" aria-busy="true">
      <p role="status" className="text-body-sm text-ink">
        Checking for a saved draft in this browser
      </p>
      <p className="mt-1 text-caption text-mute">
        Drafts stay on this device and are never uploaded.
      </p>
    </Card>
  );
}

function ResumeCard({
  draft,
  busy,
  message,
  error,
  onResume,
  onDiscard,
}: {
  draft: OcrDraft;
  busy: null | "resume" | "discard";
  message: string;
  error: string | null;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const counts = lineProgress(draft.lines);
  const hasUnfinishedUpload = draft.submission !== null;

  return (
    <Card className="mt-4 p-4 sm:p-6">
      <h2 className="text-display-sm font-semibold text-ink">
        {hasUnfinishedUpload ? "Resume your upload" : "Resume your draft"}
      </h2>
      <p className="mt-1 break-words text-body-md text-ink">
        {draft.pageLabel.trim() || draft.fileName}
      </p>
      {draft.pageLabel.trim() ? (
        <p className="mt-0.5 break-all text-caption text-mute">
          {draft.fileName}
        </p>
      ) : null}

      <dl className="mt-4 grid grid-cols-2 gap-3 text-body-sm sm:grid-cols-3">
        <div>
          <dt className="text-caption text-mute">Lines</dt>
          <dd className="tabular-nums text-ink">{draft.lines.length}</dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Labeled</dt>
          <dd className="tabular-nums text-ink">{counts.labeled}</dd>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <dt className="text-caption text-mute">Last saved</dt>
          <dd className="text-ink">{formatDraftTime(draft.updatedAt)}</dd>
        </div>
      </dl>

      {hasUnfinishedUpload ? (
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-body-sm text-body">
          This draft has an unfinished upload. Resuming sends only the line
          images that are still missing.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          className="h-11 sm:h-10"
          onClick={onResume}
          disabled={busy !== null}
        >
          {hasUnfinishedUpload ? "Resume upload" : "Resume"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-11 sm:h-10"
          onClick={onDiscard}
          disabled={busy !== null}
        >
          Discard
        </Button>
      </div>

      <p role="status" aria-live="polite" className="mt-3 text-caption text-mute">
        {busy === "resume" ? message || "Opening the saved page" : ""}
        {busy === "discard" ? "Deleting the draft" : ""}
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-body-sm text-error">
          {error}
        </p>
      ) : null}

      <p className="mt-3 text-caption text-mute">
        The page image stays in this browser. The draft is stored locally.
      </p>
    </Card>
  );
}

function SegmentationSkeleton({ message }: { message: string }) {
  return (
    <Card className="mt-4" aria-busy="true">
      <p role="status" className="text-body-sm text-ink">
        {message || "Preparing the page"}
      </p>
      <p className="mt-1 text-caption text-mute">
        Flattening, checking the tilt and finding the lines. This can take a
        moment for a large scan.
      </p>
      <div className="mt-5 flex flex-col gap-3" aria-hidden="true">
        <div className="h-3 w-1/3 rounded-full bg-surface-2" />
        <div className="h-44 rounded-md bg-surface-2" />
        <div className="h-3 w-2/3 rounded-full bg-surface-2" />
      </div>
    </Card>
  );
}
