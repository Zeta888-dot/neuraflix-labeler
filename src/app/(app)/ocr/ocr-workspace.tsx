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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { isBitmapUsable } from "@/lib/ocr/bitmap";
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
  statusForLabel,
  type LineDraft,
} from "@/lib/ocr/labels";
import {
  deleteOcrDraft,
  draftStoreMessage,
  readOcrDraft,
  writeOcrDraft,
  type OcrDraft,
} from "@/lib/ocr/draft-store";
import {
  PageSegmenter,
  decodePageFile,
  segmenterErrorMessage,
  validatePageFile,
  type SegmentPageResult,
} from "@/lib/ocr/segmenter";
import { ConfirmDialog } from "./confirm-dialog";
import { DetectionPanel } from "./detection-panel";
import { LabelingView } from "./labeling-view";
import { LinesPanel } from "./lines-panel";
import { OcrErrorBoundary } from "./ocr-error-boundary";
import { PagePreview, type PageView } from "./page-preview";

const DEBOUNCE_MS = 250;
const DRAFT_SAVE_MS = 500;
const HISTORY_LIMIT = 30;
const RESET_NOTICE =
  "Labels on the changed lines were reset or removed. Unchanged lines keep their labels.";

type Busy = null | "load" | "detect";
type Step = "review" | "label";
type HistoryEntry = { lines: LineDraft[]; selected: number; current: number };
type SaveState =
  | null
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };
type DialogKind = "discard-draft" | "new-page" | null;

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

export function OcrWorkspace({ userId }: { userId: string }) {
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const segmenterRef = useRef<PageSegmenter | null>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const fileRef = useRef<Blob | null>(null);
  const recoveryRef = useRef(false);
  const loadTokenRef = useRef(0);
  const detectTokenRef = useRef(0);
  const saveTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const manualEditsRef = useRef(false);
  const paramsRef = useRef(params);
  const appliedParamsRef = useRef<SegParams>(DEFAULT_PARAMS);
  const confirmOpenRef = useRef(false);
  const linesRef = useRef(lines);

  const boxes = lines.map((line) => line.box);
  const manualEdits = !lineBoxesEqual(boxes, detectedBoxes);

  useEffect(() => {
    paramsRef.current = params;
  }, [params]);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

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
    if (draftCheck !== "ready" || draftStorageMessage) return;
    if (!page || !fileRef.current || !fileName) return;

    const token = ++saveTokenRef.current;
    const file = fileRef.current;
    setSaveState({ kind: "saving" });

    const timer = window.setTimeout(() => {
      writeOcrDraft(userId, {
        file,
        fileName,
        params,
        boxes: lines.map((line) => line.box),
        lines,
        currentLine,
        pageLabel,
        rightsConfirmed: rights,
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

  async function resumeDraft(draft: OcrDraft) {
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
      setStep(hasProgress && canLabel ? "label" : "review");
      setLineNotice(null);
      setSaveState({ kind: "saved", at: draft.updatedAt });
      setSavedDraft(null);
      setDraftBusy(null);
      setResumeMessage("");
      setDraftActionError(null);
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
    if (draftBusy !== null) return;
    setDialog(null);
    setDraftBusy("discard");
    setDraftActionError(null);

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

  const saveText = page
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
          dialog === "discard-draft" ? "Discard this draft?" : "Start a new page?"
        }
        body={
          dialog === "discard-draft"
            ? "The saved page image and its labels will be deleted from this browser. This cannot be undone."
            : newPageBody
        }
        confirmLabel={
          dialog === "discard-draft" ? "Discard draft" : "Start new page"
        }
        cancelLabel={dialog === "discard-draft" ? "Keep draft" : "Cancel"}
        onConfirm={() => {
          if (dialog === "discard-draft") void discardDraft();
          else confirmNewPage();
        }}
        onCancel={() => {
          setDialog(null);
          setPendingFile(null);
        }}
      />

      {draftCheck === "checking" ? <DraftCheckCard /> : null}

      {draftCheck === "ready" && step === "review" ? (
        <>
          {savedDraft && !page && busy !== "load" ? (
            <ResumeCard
              draft={savedDraft}
              busy={draftBusy}
              message={resumeMessage}
              error={draftActionError}
              onResume={() => void resumeDraft(savedDraft)}
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
                The page image and the labels stay in this browser. The
                original image is never uploaded in this update.
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
          />
        </OcrErrorBoundary>
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
  const active = !hasPage ? 1 : step === "review" ? 2 : 3;

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
      <li className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className={numberClass(4)}>
            4
          </span>
          <span className="text-mute">Submit</span>
        </span>
        <span className="pl-8 text-caption text-mute">
          Coming in the next update
        </span>
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

  return (
    <Card className="mt-4 p-4 sm:p-6">
      <h2 className="text-display-sm font-semibold text-ink">
        Resume your draft
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

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          className="h-11 sm:h-10"
          onClick={onResume}
          disabled={busy !== null}
        >
          Resume
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
        The page image and labels are stored in this browser only.
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
