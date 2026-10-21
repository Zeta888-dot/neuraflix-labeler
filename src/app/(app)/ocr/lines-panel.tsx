"use client";

import {
  ArrowRight,
  ArrowUUpLeft,
  ArrowsMerge,
  Scissors,
  Trash,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { LineDraft } from "@/lib/ocr/labels";
import { LineThumb, type PageView } from "./page-preview";

type Busy = null | "load" | "detect";

export function LinesPanel({
  page,
  lines,
  selected,
  onSelect,
  onDelete,
  onMerge,
  onSplitStart,
  splitIndex,
  splitY,
  onSplitYChange,
  onSplitAt,
  onCancelSplit,
  historyLength,
  onUndo,
  busy,
  onContinue,
}: {
  page: PageView;
  lines: LineDraft[];
  selected: number;
  onSelect: (index: number) => void;
  onDelete: (index: number) => void;
  onMerge: (index: number) => void;
  onSplitStart: (index: number) => void;
  splitIndex: number | null;
  splitY: number;
  onSplitYChange: (value: number) => void;
  onSplitAt: (index: number, y: number) => void;
  onCancelSplit: () => void;
  historyLength: number;
  onUndo: () => void;
  busy: Busy;
  onContinue: () => void;
}) {
  const boxes = lines.map((line) => line.box);
  const editing = busy === null;
  const splitBox = splitIndex !== null ? boxes[splitIndex] : undefined;
  const splitMinimum = splitBox ? Math.floor(splitBox[1]) + 1 : 0;
  const splitMaximum = splitBox ? Math.ceil(splitBox[3]) - 1 : 0;
  const blockedReason =
    boxes.length === 0
      ? "No lines to label. Adjust detection or upload a clearer page."
      : boxes.length > 40
        ? `This page has ${boxes.length} lines. Delete or merge lines until there are 40 or fewer.`
        : !editing
          ? "Wait for the current update to finish."
          : null;

  return (
    <section
      className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
      aria-labelledby="ocr-lines-heading"
      aria-busy={busy === "detect"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="ocr-lines-heading"
            className="text-body-md font-medium text-ink"
          >
            Lines
          </h2>
          <p
            role="status"
            aria-live="polite"
            className="text-caption text-mute"
          >
            {boxes.length} {boxes.length === 1 ? "line" : "lines"} on this page
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-11 sm:h-8"
          onClick={onUndo}
          disabled={historyLength === 0 || !editing}
          aria-label="Undo the last line edit"
        >
          <ArrowUUpLeft size={16} weight="light" aria-hidden="true" />
          Undo
        </Button>
      </div>

      {boxes.length > 40 ? (
        <p className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-caption text-body">
          This page has {boxes.length} lines. Delete or merge lines until there
          are 40 or fewer to continue to labeling.
        </p>
      ) : null}

      {splitBox ? (
        <div className="mt-4 rounded-md bg-accent-soft p-3">
          <p className="text-body-sm font-medium text-ink">
            Split line {(splitIndex ?? 0) + 1}
          </p>
          <p className="mt-1 text-caption text-body">
            Click inside that line on the page, or enter a split point below.
            Escape cancels. Both parts are trimmed to the ink.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label htmlFor="ocr-split-y" className="text-caption text-body">
                Split point (px from top)
              </label>
              <input
                id="ocr-split-y"
                type="number"
                inputMode="numeric"
                min={splitMinimum}
                max={splitMaximum}
                step={1}
                value={splitY}
                autoFocus
                onChange={(event) => onSplitYChange(Number(event.target.value))}
                className="h-11 w-28 rounded-md bg-surface px-3 text-body-sm text-ink shadow-elev-1"
              />
            </div>
            <Button
              type="button"
              size="sm"
              className="h-11 sm:h-8"
              onClick={() => onSplitAt(splitIndex ?? 0, splitY)}
            >
              Split line
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-11 sm:h-8"
              onClick={onCancelSplit}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {boxes.length === 0 ? (
        <div className="mt-4 rounded-md bg-surface-2 p-4">
          <p className="text-body-sm text-ink">No lines were found</p>
          <p className="mt-1 text-caption text-body">
            Try a different sensitivity or minimum line height, or upload a
            clearer image. The detection runs again after you change a setting.
          </p>
        </div>
      ) : (
        <ol className="mt-4 flex flex-col gap-3">
          {lines.map((line, index) => {
            const box = line.box;
            const width = box[2] - box[0];
            const height = box[3] - box[1];
            const isSelected = index === selected;
            return (
              <li
                key={line.id}
                className={cn(
                  "rounded-md bg-surface-2 p-3",
                  isSelected &&
                    "shadow-[inset_0_0_0_2px_var(--accent)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(index)}
                  aria-pressed={isSelected}
                  aria-label={`Select line ${index + 1}`}
                  className="flex w-full items-start gap-3 rounded-sm text-left"
                >
                  <LineThumb bitmap={page.bitmap} box={box} />
                  <span className="min-w-0">
                    <span className="block text-body-sm font-medium text-ink">
                      Line {index + 1}
                    </span>
                    <span className="block text-caption tabular-nums text-mute">
                      {width.toLocaleString("en")} x{" "}
                      {height.toLocaleString("en")} px
                    </span>
                  </span>
                </button>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-11 px-3 sm:h-8"
                    onClick={() => onDelete(index)}
                    disabled={!editing}
                    aria-label={`Delete line ${index + 1}`}
                  >
                    <Trash size={16} weight="light" aria-hidden="true" />
                    Delete
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-11 px-3 sm:h-8"
                    onClick={() => onMerge(index)}
                    disabled={!editing || index === boxes.length - 1}
                    aria-label={`Merge line ${index + 1} with line ${index + 2}`}
                  >
                    <ArrowsMerge size={16} weight="light" aria-hidden="true" />
                    Merge with next
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-11 px-3 sm:h-8"
                    onClick={() => onSplitStart(index)}
                    disabled={!editing || height < 4}
                    aria-label={`Split line ${index + 1}`}
                  >
                    <Scissors size={16} weight="light" aria-hidden="true" />
                    Split
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-6 border-t border-hairline pt-4">
        <Button
          type="button"
          className="h-11 sm:h-10"
          onClick={onContinue}
          disabled={blockedReason !== null}
          aria-describedby={blockedReason ? "ocr-continue-reason" : undefined}
        >
          Continue to labeling
          <ArrowRight size={16} weight="light" aria-hidden="true" />
        </Button>
        {blockedReason ? (
          <p id="ocr-continue-reason" className="mt-2 text-caption text-body">
            {blockedReason}
          </p>
        ) : (
          <p className="mt-2 text-caption text-mute">
            Labels stay in this browser.
          </p>
        )}
      </div>
    </section>
  );
}
