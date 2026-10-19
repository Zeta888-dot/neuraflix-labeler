"use client";

import {
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { isBitmapUsable } from "@/lib/ocr/bitmap";
import type { LineBox } from "@/lib/ocr/segment-core";

export type PageView = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  angle: number;
};

const VIEWPORT_PADDING = 16;
const MIN_ZOOM = 25;
const MAX_ZOOM = 400;
const ZOOM_STEP = 25;

export function PagePreview({
  page,
  boxes,
  selected,
  splitIndex,
  onSelect,
  onSplitPick,
}: {
  page: PageView;
  boxes: LineBox[];
  selected: number;
  splitIndex: number | null;
  onSelect: (index: number) => void;
  onSplitPick: (index: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [viewportWidth, setViewportWidth] = useState(0);
  const [themeTick, setThemeTick] = useState(0);
  const bitmapUsable = isBitmapUsable(page.bitmap);

  // The canvas overlay follows the theme accent without a remount.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;

    const measure = () => setViewportWidth(node.clientWidth);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [page]);

  // A new working page gets a fresh PagePreview via key, so zoom starts
  // fitted without a state reset inside an effect.

  const fitWidth = Math.max(
    1,
    (viewportWidth > VIEWPORT_PADDING ? viewportWidth - VIEWPORT_PADDING : 640),
  );
  const fitScale = Math.min(1, fitWidth / page.width);
  const scale = zoom === "fit" ? fitScale : zoom / 100;
  const displayPercent = Math.round(scale * 100);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!isBitmapUsable(page.bitmap)) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const { width, height } = page;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(page.bitmap, 0, 0);

    const styles = getComputedStyle(canvas);
    const accent = styles.getPropertyValue("--accent").trim() || "#0070f3";
    const onAccent = styles.getPropertyValue("--on-accent").trim() || "#ffffff";
    const unit = 1 / Math.max(scale, 0.05);
    const fontFamily = styles.fontFamily || "sans-serif";

    context.lineJoin = "miter";
    boxes.forEach((box, index) => {
      const [x0, y0, x1, y1] = box;
      const boxWidth = Math.max(0, x1 - x0);
      const boxHeight = Math.max(0, y1 - y0);
      const isSelected = index === selected;

      if (isSelected) {
        context.globalAlpha = 0.12;
        context.fillStyle = accent;
        context.fillRect(x0, y0, boxWidth, boxHeight);
        context.globalAlpha = 1;
      }

      const lineWidth = isSelected ? 3 * unit : 2 * unit;
      context.strokeStyle = accent;
      context.lineWidth = lineWidth;
      context.strokeRect(
        x0 + lineWidth / 2,
        y0 + lineWidth / 2,
        Math.max(0, boxWidth - lineWidth),
        Math.max(0, boxHeight - lineWidth),
      );

      if (boxHeight < 6 || boxWidth < 6) return;

      const label = String(index + 1);
      const fontSize = Math.min(64, Math.max(10, 12 * unit));
      context.font = `600 ${fontSize}px ${fontFamily}`;
      const badgeHeight = fontSize * 1.5;
      const badgeWidth = context.measureText(label).width + fontSize * 0.8;
      const badgeX = Math.min(
        Math.max(0, x0 + 2 * unit),
        Math.max(0, width - badgeWidth),
      );
      const badgeY = Math.min(
        Math.max(0, y0 + 2 * unit),
        Math.max(0, height - badgeHeight),
      );

      context.fillStyle = accent;
      context.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
      context.fillStyle = onAccent;
      context.textBaseline = "middle";
      context.textAlign = "left";
      context.fillText(label, badgeX + fontSize * 0.4, badgeY + badgeHeight / 2);
    });

    if (splitIndex !== null && boxes[splitIndex]) {
      const [x0, y0, x1, y1] = boxes[splitIndex];
      const middle = (y0 + y1) / 2;
      context.strokeStyle = accent;
      context.lineWidth = 1 * unit;
      context.setLineDash([8 * unit, 6 * unit]);
      context.beginPath();
      context.moveTo(x0, middle);
      context.lineTo(x1, middle);
      context.stroke();
      context.setLineDash([]);
    }
  }, [page, boxes, selected, splitIndex, scale, themeTick]);

  function handleCanvasClick(event: MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const x = (event.clientX - rect.left) * (page.width / rect.width);
    const y = (event.clientY - rect.top) * (page.height / rect.height);

    if (splitIndex !== null) {
      const box = boxes[splitIndex];
      if (
        box &&
        x >= box[0] &&
        x <= box[2] &&
        y > box[1] + 1 &&
        y < box[3] - 1
      ) {
        onSplitPick(splitIndex, y);
      }
      return;
    }

    for (let index = boxes.length - 1; index >= 0; index--) {
      const [x0, y0, x1, y1] = boxes[index];
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) {
        onSelect(index);
        return;
      }
    }
  }

  const currentPercent = zoom === "fit" ? Math.round(fitScale * 100) : zoom;

  function zoomTo(value: number) {
    setZoom(Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))));
  }

  function zoomIn() {
    zoomTo(currentPercent + ZOOM_STEP);
  }

  function zoomOut() {
    zoomTo(currentPercent - ZOOM_STEP);
  }

  return (
    <div className="min-w-0 rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-body-md font-medium text-ink">Page</h2>
          <p className="text-caption text-mute">
            {page.width.toLocaleString("en")} x{" "}
            {page.height.toLocaleString("en")} px working copy
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-11 min-w-11 px-2 sm:h-8"
            onClick={zoomOut}
            aria-label="Zoom out"
          >
            <MagnifyingGlassMinus size={16} weight="light" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={cn(
              "h-11 px-3 sm:h-8",
              zoom === "fit" && "outline outline-2 outline-accent",
            )}
            onClick={() => setZoom("fit")}
            aria-pressed={zoom === "fit"}
          >
            Fit width
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={cn(
              "h-11 px-3 sm:h-8",
              zoom === 100 && "outline outline-2 outline-accent",
            )}
            onClick={() => setZoom(100)}
            aria-pressed={zoom === 100}
          >
            100%
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-11 min-w-11 px-2 sm:h-8"
            onClick={zoomIn}
            aria-label="Zoom in"
          >
            <MagnifyingGlassPlus size={16} weight="light" aria-hidden="true" />
          </Button>
          <span className="text-caption tabular-nums text-mute" aria-hidden="true">
            {displayPercent}%
          </span>
        </div>
      </div>

      <div
        ref={viewportRef}
        role="region"
        tabIndex={0}
        aria-label="Page preview. Click a line box to select it, or use the Lines list."
        className="mt-3 max-h-[70vh] overflow-auto rounded-md bg-surface-2 p-2"
      >
        {bitmapUsable ? (
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`Page image with ${boxes.length} detected line boxes.`}
            onClick={handleCanvasClick}
            className={cn(
              "block bg-white",
              splitIndex !== null && "cursor-crosshair",
            )}
            style={{
              width: `${Math.round(page.width * scale)}px`,
              height: `${Math.round(page.height * scale)}px`,
            }}
          />
        ) : (
          <p
            role="status"
            className="rounded-md bg-surface px-3 py-6 text-body-sm text-body"
          >
            Reloading your page...
          </p>
        )}
      </div>

      <p className="mt-2 text-caption text-mute">
        Click a box to select it. The Lines list is the keyboard and screen
        reader path. The page image stays in this browser.
      </p>
    </div>
  );
}

/** Small crop of one line, drawn from the working page bitmap. */
export function LineThumb({
  bitmap,
  box,
}: {
  bitmap: ImageBitmap;
  box: LineBox;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (!isBitmapUsable(bitmap)) return;

    const sourceWidth = Math.max(1, box[2] - box[0]);
    const sourceHeight = Math.max(1, box[3] - box[1]);
    const factor = Math.min(1, 168 / sourceWidth, 56 / sourceHeight);
    const targetWidth = Math.max(1, Math.round(sourceWidth * factor));
    const targetHeight = Math.max(1, Math.round(sourceHeight * factor));

    if (canvas.width !== targetWidth) canvas.width = targetWidth;
    if (canvas.height !== targetHeight) canvas.height = targetHeight;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      box[0],
      box[1],
      sourceWidth,
      sourceHeight,
      0,
      0,
      targetWidth,
      targetHeight,
    );
  }, [bitmap, box]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="block rounded-xs bg-white shadow-elev-1"
    />
  );
}
