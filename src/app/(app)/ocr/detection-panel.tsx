"use client";

import { CaretDown } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import {
  DEFAULT_PARAMS,
  PARAM_RANGES,
  segParamsEqual,
  type SegParams,
} from "@/lib/ocr/segment-core";
import type { PageView } from "./page-preview";

type Busy = null | "load" | "detect";

type SliderKey = "sensitivity" | "minHeight" | "mergeGap" | "pad";

const SLIDERS: {
  key: SliderKey;
  label: string;
  hint: string;
  format: (value: number) => string;
}[] = [
  {
    key: "sensitivity",
    label: "Sensitivity",
    hint: "Lower values keep faint dots and diacritics.",
    format: (value) => value.toFixed(3),
  },
  {
    key: "minHeight",
    label: "Minimum line height",
    hint: "Bands shorter than this are dropped as noise.",
    format: (value) => `${value} px`,
  },
  {
    key: "mergeGap",
    label: "Merge gap",
    hint: "Bands closer than this are joined into one line.",
    format: (value) => `${value} px`,
  },
  {
    key: "pad",
    label: "Padding",
    hint: "Margin added around every line box.",
    format: (value) => `${value} px`,
  },
];

export function DetectionPanel({
  page,
  originalSize,
  params,
  onParamsChange,
  onReset,
  busy,
  progress,
  confirmOpen,
  onConfirm,
  onCancel,
}: {
  page: PageView;
  originalSize: { width: number; height: number } | null;
  params: SegParams;
  onParamsChange: (params: SegParams) => void;
  onReset: () => void;
  busy: Busy;
  progress: string;
  confirmOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(true);
  const tilt = Math.abs(page.angle);
  const downscaled =
    originalSize !== null &&
    Math.max(originalSize.width, originalSize.height) > 3000;

  const sizeText = downscaled
    ? `Downscaled to ${page.width.toLocaleString("en")} x ${page.height.toLocaleString("en")} px from ${originalSize.width.toLocaleString("en")} x ${originalSize.height.toLocaleString("en")} px. The long edge is capped at 3,000 px.`
    : `Working copy is ${page.width.toLocaleString("en")} x ${page.height.toLocaleString("en")} px, the original size.`;

  const tiltText =
    tilt <= 0.01
      ? "No page tilt detected."
      : params.deskew
        ? `Straightened by ${tilt.toFixed(2)} degrees.`
        : `A tilt of ${tilt.toFixed(2)} degrees was found. Deskew is off.`;

  return (
    <section
      className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
      aria-labelledby="ocr-detection-heading"
      aria-busy={busy === "detect"}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2
            id="ocr-detection-heading"
            className="text-body-md font-medium text-ink"
          >
            Detection
          </h2>
          <p className="text-caption text-mute">
            Runs in this browser. Change a setting to detect again.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-11 min-w-11 lg:hidden"
          aria-expanded={open}
          aria-controls="ocr-detection-controls"
          aria-label={open ? "Hide detection settings" : "Show detection settings"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Show"}
          <CaretDown
            size={16}
            weight="light"
            aria-hidden="true"
            className={cn("transition-transform", !open && "-rotate-90")}
          />
        </Button>
      </div>

      <div
        id="ocr-detection-controls"
        className={cn("mt-4", !open && "hidden lg:block")}
      >
        <p className="text-caption text-mute">{sizeText}</p>
        <p className="mt-1 text-caption text-mute">{tiltText}</p>

        <div className="mt-4 flex min-h-11 items-center justify-between gap-3 rounded-md bg-surface-2 px-3">
          <span id="ocr-deskew-label" className="text-body-sm text-ink">
            Deskew
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={params.deskew}
            aria-labelledby="ocr-deskew-label"
            onClick={() =>
              onParamsChange({ ...params, deskew: !params.deskew })
            }
            className={cn(
              "inline-flex h-11 min-w-11 shrink-0 items-center justify-end rounded-full",
              "outline-none transition-colors duration-150 ease-[var(--ease-out-quart)]",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                params.deskew ? "bg-accent" : "bg-hairline-strong",
              )}
            >
              <span
                className={cn(
                  "absolute size-4 rounded-full bg-on-accent transition-transform",
                  params.deskew ? "translate-x-6" : "translate-x-1",
                )}
              />
            </span>
            <span className="sr-only">
              {params.deskew ? "On" : "Off"}
            </span>
          </button>
        </div>
        <p className="mt-1 text-caption text-mute">
          Straightens tilted scans before the lines are found.
        </p>

        <div className="mt-4 flex flex-col gap-4">
          {SLIDERS.map((slider) => {
            const range = PARAM_RANGES[slider.key];
            const value = params[slider.key];
            const valueText = slider.format(value);
            const hintId = `ocr-${slider.key}-hint`;
            return (
              <div key={slider.key}>
                <div className="flex items-center justify-between gap-2">
                  <label
                    htmlFor={`ocr-${slider.key}`}
                    className="text-body-sm text-ink"
                  >
                    {slider.label}
                  </label>
                  <output
                    htmlFor={`ocr-${slider.key}`}
                    className="font-mono text-caption tabular-nums text-body"
                  >
                    {valueText}
                  </output>
                </div>
                <input
                  id={`ocr-${slider.key}`}
                  type="range"
                  min={range.min}
                  max={range.max}
                  step={range.step}
                  value={value}
                  aria-valuetext={valueText}
                  aria-describedby={hintId}
                  onChange={(event) =>
                    onParamsChange({
                      ...params,
                      [slider.key]: Number(event.target.value),
                    })
                  }
                  className="mt-1 h-11 w-full cursor-pointer accent-[var(--accent)]"
                />
                <p id={hintId} className="text-caption text-mute">
                  {slider.hint}
                </p>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-11 sm:h-8"
            onClick={onReset}
            disabled={busy !== null || segParamsEqual(params, DEFAULT_PARAMS)}
          >
            Reset
          </Button>
          <span role="status" className="text-caption text-mute">
            {busy === "detect" ? progress || "Detecting lines again..." : ""}
          </span>
        </div>
      </div>

      <ReDetectDialog open={confirmOpen} onConfirm={onConfirm} onCancel={onCancel} />
    </section>
  );
}

function ReDetectDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="ocr-redetect-title"
      aria-describedby="ocr-redetect-body"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onCancel();
      }}
      className="m-auto w-[min(92vw,440px)] rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
    >
      <h2 id="ocr-redetect-title" className="text-display-sm font-semibold">
        Detect lines again?
      </h2>
      <p id="ocr-redetect-body" className="mt-2 text-body-sm text-body">
        Re-detecting replaces your manual edits and resets labels on changed
        lines. Unchanged lines keep their labels. The page image stays in this
        browser and is not uploaded.
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          className="h-11 sm:h-10"
          onClick={onCancel}
          autoFocus
        >
          Cancel
        </Button>
        <Button
          type="button"
          className="h-11 sm:h-10"
          onClick={onConfirm}
        >
          Detect again
        </Button>
      </div>
    </dialog>
  );
}
