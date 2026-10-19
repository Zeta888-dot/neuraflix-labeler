"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  EyeSlash,
  X,
} from "@phosphor-icons/react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import { KhowarField } from "@/components/khowar/KhowarField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { isBitmapUsable } from "@/lib/ocr/bitmap";
import { cropToCanvas } from "@/lib/ocr/crop";
import {
  lineProgress,
  nextEmptyLineIndex,
  nextLineIndex,
  previousLineIndex,
  validateLabel,
  type LineDraft,
  type LineStatus,
} from "@/lib/ocr/labels";
import { LineThumb, type PageView } from "./page-preview";

const STATUS_LABEL: Record<LineStatus, string> = {
  labeled: "Labeled",
  unreadable: "Unreadable",
  empty: "Empty",
};

const STATUS_TONE: Record<LineStatus, "accent" | "error" | "neutral"> = {
  labeled: "accent",
  unreadable: "error",
  empty: "neutral",
};

function focusField(node: HTMLInputElement | null) {
  node?.focus();
}

export function LabelingView({
  page,
  lines,
  current,
  onCurrentChange,
  onLineChange,
  onToggleUnreadable,
  onClearLine,
  onBack,
  pageLabel,
  onPageLabelChange,
  rights,
  onRightsChange,
}: {
  page: PageView;
  lines: LineDraft[];
  current: number;
  onCurrentChange: (index: number) => void;
  onLineChange: (index: number, value: string) => void;
  onToggleUnreadable: (index: number) => void;
  onClearLine: (index: number) => void;
  onBack: () => void;
  pageLabel: string;
  onPageLabelChange: (value: string) => void;
  rights: boolean;
  onRightsChange: (value: boolean) => void;
}) {
  const total = lines.length;
  const safeCurrent = Math.min(
    Math.max(0, current),
    Math.max(0, total - 1),
  );
  const line = lines[safeCurrent];
  const progress = lineProgress(lines);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "empty" | "unreadable">("all");
  const fieldRef = useRef<HTMLInputElement | null>(null);

  function focusCurrentField() {
    focusField(fieldRef.current);
  }

  function go(index: number) {
    if (index < 0 || index >= total || index === safeCurrent) {
      focusCurrentField();
      return;
    }
    setError(null);
    onCurrentChange(index);
  }

  function saveAndAdvance() {
    if (!line) return;

    if (line.status !== "unreadable") {
      const result = validateLabel(line.label);
      if (!result.ok) {
        setError(result.error);
        focusCurrentField();
        return;
      }
      onLineChange(safeCurrent, result.value);
    }

    setError(null);
    if (safeCurrent < total - 1) onCurrentChange(safeCurrent + 1);
    else focusCurrentField();
  }

  // Keep focus in the line field after every move.
  useEffect(() => {
    const frame = requestAnimationFrame(() => focusCurrentField());
    return () => cancelAnimationFrame(frame);
  }, [safeCurrent]);

  // Enter is handled by the field; Alt arrows and Escape work from anywhere.
  useEffect(() => {
    function onWindowKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;

      if (event.altKey && event.key === "ArrowLeft") {
        event.preventDefault();
        go(previousLineIndex(safeCurrent, total));
        return;
      }
      if (event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        go(nextLineIndex(safeCurrent, total));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        focusCurrentField();
      }
    }

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  });

  function handleFieldKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) {
    if (event.key !== "Enter") return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    saveAndAdvance();
  }

  const nextEmpty = nextEmptyLineIndex(lines, safeCurrent);
  const filtered = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => filter === "all" || line.status === filter);
  const done = progress.labeled + progress.unreadable;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const progressText = `${progress.labeled} labeled, ${progress.unreadable} unreadable, ${progress.empty} left`;

  if (!line) {
    return (
      <Card className="mt-4">
        <h2 className="text-body-md font-medium text-ink">
          There are no lines to label
        </h2>
        <p className="mt-1 text-body-sm text-body">
          Go back to the line review and add at least one line.
        </p>
        <Button
          type="button"
          variant="secondary"
          className="mt-4 h-11 sm:h-10"
          onClick={onBack}
        >
          <ArrowLeft size={16} weight="light" aria-hidden="true" />
          Back to lines
        </Button>
      </Card>
    );
  }

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start xl:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0">
        <section
          className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
          aria-labelledby="ocr-label-heading"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2
                id="ocr-label-heading"
                className="text-body-md font-medium text-ink"
              >
                Label the line
              </h2>
              <p className="text-caption tabular-nums text-mute">
                {safeCurrent + 1} of {total}
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="h-11 sm:h-10"
              onClick={onBack}
            >
              <ArrowLeft size={16} weight="light" aria-hidden="true" />
              Back to lines
            </Button>
          </div>

          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-body">
              <span
                role="status"
                aria-live="polite"
                className="font-medium text-ink"
              >
                Line {safeCurrent + 1} of {total}
              </span>
              <span className="tabular-nums">{progressText}</span>
            </div>
            <div
              role="progressbar"
              aria-label="Labeling progress"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-valuetext={progressText}
              className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200 ease-[var(--ease-out-quart)]"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <LineImage
            page={page}
            line={line}
            index={safeCurrent}
            total={total}
          />

          <div className="mt-4">
            <KhowarField
              id="ocr-line-label"
              label="Line text"
              value={line.label}
              onChange={(value) => {
                setError(null);
                onLineChange(safeCurrent, value);
              }}
              singleLine
              inputRef={fieldRef}
              error={error}
              hint="Enter saves and moves to the next line."
              onKeyDown={handleFieldKeyDown}
            />
            {line.status === "unreadable" ? (
              <p className="mt-2 text-caption text-body">
                This line is marked unreadable. Typing in the field clears that
                mark.
              </p>
            ) : null}
            <p className="mt-2 text-caption text-mute">
              Alt + Left and Alt + Right move between lines. Escape returns to
              this field.
            </p>
          </div>

          <div className="sticky bottom-0 z-20 -mx-4 mt-5 border-t border-hairline bg-canvas/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
            <div className="flex items-center justify-between gap-2 text-caption text-body lg:hidden">
              <span className="tabular-nums">
                Line {safeCurrent + 1} of {total}
              </span>
              <span className="tabular-nums">{progressText}</span>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 lg:mt-0 lg:flex lg:flex-wrap">
              <Button
                type="button"
                variant="secondary"
                className="h-11 sm:h-10"
                onClick={() => go(previousLineIndex(safeCurrent, total))}
                disabled={safeCurrent === 0}
              >
                <ArrowLeft size={16} weight="light" aria-hidden="true" />
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="h-11 sm:h-10"
                onClick={() => go(nextLineIndex(safeCurrent, total))}
                disabled={safeCurrent === total - 1}
              >
                Next
                <ArrowRight size={16} weight="light" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                className="col-span-2 h-11 sm:col-span-1 sm:h-10"
                onClick={saveAndAdvance}
              >
                <Check size={16} weight="light" aria-hidden="true" />
                Save and next
              </Button>
              <Button
                type="button"
                variant="secondary"
                className={cn(
                  "h-11 sm:h-10",
                  line.status === "unreadable" &&
                    "outline outline-2 outline-accent",
                )}
                aria-pressed={line.status === "unreadable"}
                aria-label={
                  line.status === "unreadable"
                    ? "Remove the unreadable mark"
                    : "Mark the line as unreadable"
                }
                onClick={() => {
                  setError(null);
                  onToggleUnreadable(safeCurrent);
                }}
              >
                <EyeSlash size={16} weight="light" aria-hidden="true" />
                <span className="sm:hidden">Unreadable</span>
                <span className="hidden sm:inline">Mark as unreadable</span>
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-11 sm:h-10"
                onClick={() => {
                  setError(null);
                  onClearLine(safeCurrent);
                  focusCurrentField();
                }}
              >
                <X size={16} weight="light" aria-hidden="true" />
                Clear
              </Button>
            </div>
          </div>

          {progress.empty === 0 ? (
            <section
              aria-labelledby="ocr-summary-heading"
              className="mt-5 rounded-md bg-accent-soft p-4"
            >
              <h2
                id="ocr-summary-heading"
                className="text-body-md font-medium text-ink"
              >
                All lines have a label or are marked unreadable
              </h2>
              <p className="mt-1 text-caption text-body">
                {progress.labeled} labeled, {progress.unreadable} unreadable.
              </p>
              <Button
                type="button"
                className="mt-3 h-11 sm:h-10"
                disabled
                aria-describedby="ocr-submit-reason"
              >
                Submit page
              </Button>
              <p id="ocr-submit-reason" className="mt-2 text-caption text-mute">
                Submitting pages opens in the next update.
              </p>
            </section>
          ) : null}
        </section>
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <section
          className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
          aria-labelledby="ocr-minimap-heading"
        >
          <h2
            id="ocr-minimap-heading"
            className="text-body-md font-medium text-ink"
          >
            Page map
          </h2>
          <p className="mt-1 text-caption text-mute">
            Click a box to jump to that line. The lines list is the keyboard
            path.
          </p>
          <PageMinimap
            page={page}
            lines={lines}
            current={safeCurrent}
            onSelect={go}
          />
        </section>

        <section
          className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
          aria-labelledby="ocr-lines-strip-heading"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2
              id="ocr-lines-strip-heading"
              className="text-body-md font-medium text-ink"
            >
              Lines
            </h2>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-11 sm:h-9"
              onClick={() => {
                if (nextEmpty !== null) go(nextEmpty);
              }}
              disabled={nextEmpty === null || nextEmpty === safeCurrent}
            >
              Jump to next empty line
            </Button>
          </div>

          <div
            role="group"
            aria-label="Filter lines"
            className="mt-3 flex flex-wrap gap-1.5"
          >
            {(
              [
                ["all", "All"],
                ["empty", "Empty"],
                ["unreadable", "Unreadable"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "h-11 rounded-full px-3 text-caption transition-colors sm:h-8",
                  filter === value
                    ? "bg-solid text-on-solid"
                    : "bg-surface-2 text-body hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-caption text-body">
              No lines match this filter.
            </p>
          ) : (
            <ol className="mt-3 flex max-h-[420px] flex-col gap-1.5 overflow-y-auto pr-1">
              {filtered.map(({ line: item, index }) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => go(index)}
                    aria-current={index === safeCurrent ? "true" : undefined}
                    aria-label={`Line ${index + 1}, ${STATUS_LABEL[
                      item.status
                    ].toLowerCase()}`}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors",
                      index === safeCurrent
                        ? "bg-accent-soft shadow-[inset_0_0_0_1px_var(--accent)]"
                        : "bg-surface-2 hover:bg-surface",
                    )}
                  >
                    <LineThumb bitmap={page.bitmap} box={item.box} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body-sm font-medium text-ink">
                        Line {index + 1}
                      </span>
                      <span className="mt-1 block">
                        <Badge tone={STATUS_TONE[item.status]}>
                          {STATUS_LABEL[item.status]}
                        </Badge>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section
          className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
          aria-labelledby="ocr-page-details-heading"
        >
          <h2
            id="ocr-page-details-heading"
            className="text-body-md font-medium text-ink"
          >
            Page details
          </h2>

          <div className="mt-4">
            <label
              htmlFor="ocr-page-label"
              className="text-body-sm font-medium text-ink"
            >
              Page label
            </label>
            <p className="text-caption text-mute">Optional.</p>
            <Input
              id="ocr-page-label"
              maxLength={120}
              autoComplete="off"
              aria-describedby="ocr-page-label-help"
              value={pageLabel}
              onChange={(event) => onPageLabelChange(event.target.value)}
              placeholder="Book name and page number"
              className="mt-2"
            />
            <p
              id="ocr-page-label-help"
              className="mt-1 text-caption text-mute"
            >
              For example the book name and page number. Up to 120 characters.
            </p>
          </div>

          <div className="mt-5 border-t border-hairline pt-4">
            <Checkbox
              checked={rights}
              required
              aria-required="true"
              onChange={(event) => onRightsChange(event.target.checked)}
              label="I own this page, it is in the public domain, or I have permission to share it."
            />
            <p className="mt-2 text-caption text-mute">
              Required before you can submit.
            </p>
          </div>

          <p className="mt-4 text-caption text-mute">
            The page image, page label and line labels stay in this browser.
          </p>
        </section>
      </aside>
    </div>
  );
}

function LineImage({
  page,
  line,
  index,
  total,
}: {
  page: PageView;
  line: LineDraft;
  index: number;
  total: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState<1 | 2>(1);
  const [contrast, setContrast] = useState(false);
  const [drawError, setDrawError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let frame = 0;
    try {
      if (!isBitmapUsable(page.bitmap)) {
        throw new Error("The page image is no longer available.");
      }
      const crop = cropToCanvas(page.bitmap, line.box);
      if (canvas.width !== crop.width) canvas.width = crop.width;
      if (canvas.height !== crop.height) canvas.height = crop.height;

      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas 2D is not available.");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(crop, 0, 0);
      frame = requestAnimationFrame(() => setDrawError(false));
    } catch {
      frame = requestAnimationFrame(() => setDrawError(true));
    }

    return () => cancelAnimationFrame(frame);
  }, [page.bitmap, line.box]);

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="Line image zoom"
          className="flex items-center gap-1.5"
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(
              "h-11 min-w-11 px-3 sm:h-8",
              zoom === 1 && "outline outline-2 outline-accent",
            )}
            aria-pressed={zoom === 1}
            onClick={() => setZoom(1)}
          >
            1x
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className={cn(
              "h-11 min-w-11 px-3 sm:h-8",
              zoom === 2 && "outline outline-2 outline-accent",
            )}
            aria-pressed={zoom === 2}
            onClick={() => setZoom(2)}
          >
            2x
          </Button>
        </div>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={cn(
            "h-11 px-3 sm:h-8",
            contrast && "outline outline-2 outline-accent",
          )}
          aria-pressed={contrast}
          onClick={() => setContrast((value) => !value)}
        >
          Contrast
        </Button>
      </div>

      <div
        className={cn(
          "mt-3 max-h-[min(45vh,360px)] overflow-auto rounded-md bg-surface-2 p-2",
          drawError && "hidden",
        )}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Line ${index + 1} of ${total}`}
          className={cn(
            "block h-auto bg-white",
            zoom === 2 ? "w-[200%] max-w-none" : "w-full",
          )}
          style={{ filter: contrast ? "contrast(1.6)" : undefined }}
        />
      </div>

      {drawError ? (
        <p
          role="status"
          className="mt-3 rounded-md bg-surface-2 px-3 py-8 text-center text-body-sm text-body"
        >
          The line image could not be drawn. You can still type the label.
        </p>
      ) : null}
    </div>
  );
}

function PageMinimap({
  page,
  lines,
  current,
  onSelect,
}: {
  page: PageView;
  lines: LineDraft[];
  current: number;
  onSelect: (index: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const [drawError, setDrawError] = useState(false);

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setThemeTick((tick) => tick + 1),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let frame = 0;

    try {
      if (!isBitmapUsable(page.bitmap)) {
        throw new Error("The page image is no longer available.");
      }

      const scale = Math.min(1, 420 / page.width);
      const width = Math.max(1, Math.round(page.width * scale));
      const height = Math.max(1, Math.round(page.height * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) return;

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(page.bitmap, 0, 0, width, height);

      const styles = getComputedStyle(canvas);
      const accent = styles.getPropertyValue("--accent").trim() || "#0070f3";
      context.strokeStyle = accent;
      context.lineWidth = 1.5;

      lines.forEach((line, index) => {
        const [x0, y0, x1, y1] = line.box;
        const boxX = x0 * scale;
        const boxY = y0 * scale;
        const boxWidth = Math.max(1, (x1 - x0) * scale);
        const boxHeight = Math.max(1, (y1 - y0) * scale);

        if (index === current) {
          context.globalAlpha = 0.18;
          context.fillStyle = accent;
          context.fillRect(boxX, boxY, boxWidth, boxHeight);
          context.globalAlpha = 1;
          context.lineWidth = 2.5;
        } else {
          context.lineWidth = 1;
        }

        context.strokeRect(boxX, boxY, boxWidth, boxHeight);
      });
    } catch {
      frame = requestAnimationFrame(() => setDrawError(true));
    }

    return () => cancelAnimationFrame(frame);
  }, [page, lines, current, themeTick]);

  function handleClick(event: MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = (event.clientX - rect.left) * (page.width / rect.width);
    const y = (event.clientY - rect.top) * (page.height / rect.height);

    for (let index = lines.length - 1; index >= 0; index--) {
      const [x0, y0, x1, y1] = lines[index].box;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        onSelect(index);
        return;
      }
    }
  }

  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Page preview with ${lines.length} line boxes. Click a box to jump to that line.`}
        onClick={handleClick}
        className={cn(
          "block h-auto max-h-[240px] w-auto max-w-full cursor-pointer rounded-xs bg-white shadow-elev-1",
          drawError && "hidden",
        )}
      />
      {drawError ? (
        <p
          role="status"
          className="rounded-md bg-surface-2 px-3 py-4 text-center text-body-sm text-body"
        >
          The page map could not be drawn. Reload the page to try again.
        </p>
      ) : null}
    </div>
  );
}
