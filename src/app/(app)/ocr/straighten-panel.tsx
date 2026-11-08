"use client";

import {
  ArrowCounterClockwise,
  Check,
  SkipForward,
  Sparkle,
} from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  analyzePage,
  defaultStraightenQuad,
  straightenErrorMessage,
  warpCanvas,
  type StraightenSource,
} from "@/lib/ocr/straighten-image";
import {
  clampPoint,
  clampRotation,
  isQuadValid,
  outputSizeForQuad,
  type Point,
  type Quad,
  type StraightenSettings,
} from "@/lib/ocr/straighten";

type Mode = "edit" | "result";
type ResultState = { canvas: HTMLCanvasElement; settings: StraightenSettings };

const CORNER_LABELS = [
  "Top left corner",
  "Top right corner",
  "Bottom right corner",
  "Bottom left corner",
] as const;

const PREVIEW_EDGE = 1100;

export function StraightenPanel({
  source,
  busy,
  onApply,
  onSkip,
}: {
  source: StraightenSource;
  busy: boolean;
  onApply: (
    bitmap: ImageBitmap,
    settings: StraightenSettings,
  ) => Promise<void> | void;
  onSkip: () => void;
}) {
  const rotationId = useId();
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [quad, setQuad] = useState<Quad>(() =>
    defaultStraightenQuad(source.width, source.height),
  );
  const [rotation, setRotation] = useState(0);
  const [mode, setMode] = useState<Mode>("edit");
  const [result, setResult] = useState<ResultState | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const preview = useMemo(() => {
    const scale = Math.min(
      1,
      PREVIEW_EDGE / Math.max(source.width, source.height),
    );
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
    };
  }, [source]);

  // Draw the decoded, EXIF-corrected page once. The quad is an HTML/SVG
  // overlay so handles stay crisp while the page is scaled down.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, preview.width, preview.height);
    context.drawImage(source.bitmap, 0, 0, preview.width, preview.height);
  }, [source, preview]);

  // Start from the detected page edges and the residual text tilt. This runs
  // only when the source changes. The parent remounts the panel for a new
  // source, so state is already fresh here.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const analysis = analyzePage(source.bitmap);
        setQuad(analysis.quad);
        setRotation(analysis.rotation);
        if (analysis.rotation !== 0) {
          setNotice(
            `Auto deskew starts at ${analysis.rotation.toFixed(1)} degrees.`,
          );
        }
      } catch {
        setNotice(
          "The page edges could not be detected automatically. Drag the four corners to the page.",
        );
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source]);

  function detectCorners() {
    try {
      const analysis = analyzePage(source.bitmap);
      setQuad(analysis.quad);
      setRotation(analysis.rotation);
      setMode("edit");
      setResult(null);
      setError(null);
      setNotice(
        analysis.rotation === 0
          ? "Corners detected. No tilt correction is needed."
          : `Corners detected. Auto deskew is ${analysis.rotation.toFixed(1)} degrees.`,
      );
    } catch {
      setError(
        "The page edges could not be detected. Drag the four corners to the page instead.",
      );
    }
  }

  function resetCorners() {
    setQuad(defaultStraightenQuad(source.width, source.height));
    setRotation(0);
    setMode("edit");
    setResult(null);
    setError(null);
    setNotice("Corners reset to the image edge.");
  }

  function movePoint(index: number, point: Point) {
    const next = quad.map((item, itemIndex) =>
      itemIndex === index
        ? clampPoint(point, source.width, source.height)
        : item,
    ) as Quad;
    setQuad(next);
    setMode("edit");
    setResult(null);
    setError(null);
  }

  function pointFromEvent(event: ReactPointerEvent<HTMLElement>): Point | null {
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * source.width,
      y: ((event.clientY - rect.top) / rect.height) * source.height,
    };
  }

  function handlePointerDown(
    index: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    if (point) movePoint(index, point);
  }

  function handlePointerMove(
    index: number,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromEvent(event);
    if (point) movePoint(index, point);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleCornerKeyDown(
    index: number,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    const step = Math.max(
      1,
      Math.round(Math.min(source.width, source.height) * 0.004),
    );
    const largeStep = step * 5;
    const amount = event.shiftKey ? largeStep : step;
    let dx = 0;
    let dy = 0;

    if (event.key === "ArrowLeft") dx = -amount;
    else if (event.key === "ArrowRight") dx = amount;
    else if (event.key === "ArrowUp") dy = -amount;
    else if (event.key === "ArrowDown") dy = amount;
    else return;

    event.preventDefault();
    const point = quad[index];
    movePoint(index, { x: point.x + dx, y: point.y + dy });
  }

  async function apply() {
    if (working || busy) return;
    if (!isQuadValid(quad, source.width, source.height)) {
      setError(
        "The four corners must form a page shape. Move them so the edges no longer cross.",
      );
      return;
    }

    setWorking(true);
    setError(null);
    // Let the busy state paint before the pixel loop starts.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );

    try {
      const size = outputSizeForQuad(quad);
      const canvas = warpCanvas(
        source.bitmap,
        source.width,
        source.height,
        quad,
        size.width,
        size.height,
        rotation,
      );
      setResult({
        canvas,
        settings: {
          corners: quad.map((point) => ({ ...point })) as Quad,
          rotation: clampRotation(rotation),
        },
      });
      setMode("result");
      setWorking(false);
    } catch (caught) {
      setError(
        straightenErrorMessage(
          caught,
          "The page could not be straightened. Try again, or skip straightening.",
        ),
      );
      setWorking(false);
    }
  }

  async function commitResult() {
    if (!result || working || busy) return;
    setWorking(true);
    setError(null);

    try {
      const bitmap = await createImageBitmap(result.canvas);
      await onApply(bitmap, result.settings);
    } catch {
      setError(
        "The straightened page could not be prepared. Try again, or skip straightening.",
      );
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;

  return (
    <section
      className="mt-4 rounded-lg bg-surface p-4 shadow-elev-2 sm:p-6"
      aria-labelledby="ocr-straighten-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="ocr-straighten-heading"
            className="text-display-sm font-semibold text-ink"
          >
            Straighten the page
          </h2>
          <p className="mt-1 max-w-[65ch] text-body-sm text-body">
            Drag the four corners to the edge of the page. Apply turns the
            working copy into a rectangle. Skip keeps a flat scan as it is.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            className="h-11 sm:h-10"
            onClick={detectCorners}
            disabled={disabled}
          >
            <Sparkle size={16} weight="light" aria-hidden="true" />
            Detect corners
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-11 sm:h-10"
            onClick={resetCorners}
            disabled={disabled}
          >
            <ArrowCounterClockwise
              size={16}
              weight="light"
              aria-hidden="true"
            />
            Reset
          </Button>
        </div>
      </div>

      {mode === "edit" ? (
        <>
          <div ref={wrapperRef} className="relative mt-4 select-none">
            <canvas
              ref={previewRef}
              role="img"
              aria-label="The page image with four adjustable corners"
              className="block h-auto w-full rounded-md bg-surface-2"
            />
            <svg
              viewBox={`0 0 ${source.width} ${source.height}`}
              preserveAspectRatio="none"
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              <polygon
                points={quad
                  .map((point) => `${point.x},${point.y}`)
                  .join(" ")}
                fill="var(--accent)"
                fillOpacity={0.06}
                stroke="var(--accent)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            </svg>

            {quad.map((point, index) => (
              <button
                key={CORNER_LABELS[index]}
                type="button"
                aria-label={`${CORNER_LABELS[index]}. Drag or use the arrow keys to move it.`}
                onPointerDown={(event) => handlePointerDown(index, event)}
                onPointerMove={(event) => handlePointerMove(index, event)}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                onKeyDown={(event) => handleCornerKeyDown(index, event)}
                className="absolute flex size-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full text-accent-text outline-none focus-visible:ring-2 focus-visible:ring-accent"
                style={{
                  left: `${(point.x / source.width) * 100}%`,
                  top: `${(point.y / source.height) * 100}%`,
                }}
              >
                <span
                  aria-hidden="true"
                  className="size-3.5 rounded-full border-2 border-white bg-accent shadow-elev-2"
                />
              </button>
            ))}
          </div>

          <div className="mt-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label
                htmlFor={rotationId}
                className="text-body-sm font-medium text-ink"
              >
                Fine rotate
              </label>
              <output
                htmlFor={rotationId}
                className="text-body-sm tabular-nums text-body"
              >
                {rotation.toFixed(1)} degrees
              </output>
            </div>
            <input
              id={rotationId}
              type="range"
              min={-8}
              max={8}
              step={0.1}
              value={rotation}
              disabled={disabled}
              onChange={(event) => {
                setRotation(clampRotation(Number(event.target.value)));
                setResult(null);
                setError(null);
              }}
              className="mt-2 h-11 w-full accent-[var(--accent)]"
            />
            <p className="text-caption text-mute">
              Positive values turn clockwise. Auto deskew sets the starting
              value from the text lines.
            </p>
          </div>

          {notice ? (
            <p role="status" className="mt-3 text-caption text-body">
              {notice}
            </p>
          ) : null}
        </>
      ) : null}

      {mode === "result" && result ? (
        <div className="mt-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <figure>
              <figcaption className="text-caption text-mute">Before</figcaption>
              <StaticSourcePreview source={source} quad={quad} />
            </figure>
            <figure>
              <figcaption className="text-caption text-mute">After</figcaption>
              <StaticCanvasPreview canvas={result.canvas} />
            </figure>
          </div>
          <p className="mt-3 text-caption text-mute">
            The after image is {" "}
            {result.canvas.width.toLocaleString("en")} x{" "}
            {result.canvas.height.toLocaleString("en")} px. The original page
            stays in this browser.
          </p>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-body-sm text-error">
          {error}
        </p>
      ) : null}

      {busy ? (
        <p role="status" className="mt-3 text-caption text-body">
          Detecting lines on the straightened page...
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {mode === "result" ? (
          <>
            <Button
              type="button"
              className="h-11 sm:h-10"
              onClick={() => void commitResult()}
              disabled={disabled}
            >
              <Check size={16} weight="light" aria-hidden="true" />
              {working ? "Preparing" : "Use this page"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="h-11 sm:h-10"
              onClick={() => setMode("edit")}
              disabled={disabled}
            >
              Back to corners
            </Button>
          </>
        ) : (
          <Button
            type="button"
            className="h-11 sm:h-10"
            onClick={() => void apply()}
            disabled={disabled}
          >
            {working ? "Straightening" : "Apply and preview"}
          </Button>
        )}

        <Button
          type="button"
          variant="secondary"
          className="h-11 sm:h-10"
          onClick={onSkip}
          disabled={disabled}
        >
          <SkipForward size={16} weight="light" aria-hidden="true" />
          Skip straightening
        </Button>
      </div>
    </section>
  );
}

function StaticSourcePreview({
  source,
  quad,
}: {
  source: StraightenSource;
  quad: Quad;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const size = useMemo(() => {
    const scale = Math.min(1, 700 / Math.max(source.width, source.height));
    return {
      width: Math.max(1, Math.round(source.width * scale)),
      height: Math.max(1, Math.round(source.height * scale)),
    };
  }, [source]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source.bitmap, 0, 0, size.width, size.height);
  }, [source, size]);

  return (
    <div className="relative mt-1">
      <canvas
        ref={ref}
        role="img"
        aria-label="The original page before straightening"
        className="block h-auto w-full rounded-md bg-surface-2"
      />
      <QuadOverlay quad={quad} width={source.width} height={source.height} />
    </div>
  );
}

function StaticCanvasPreview({ canvas }: { canvas: HTMLCanvasElement }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const size = useMemo(() => {
    const scale = Math.min(1, 700 / Math.max(canvas.width, canvas.height));
    return {
      width: Math.max(1, Math.round(canvas.width * scale)),
      height: Math.max(1, Math.round(canvas.height * scale)),
    };
  }, [canvas]);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.width = size.width;
    node.height = size.height;
    const context = node.getContext("2d");
    if (!context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(canvas, 0, 0, size.width, size.height);
  }, [canvas, size]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="The page after straightening"
      className="mt-1 block h-auto w-full rounded-md bg-surface-2"
    />
  );
}

function QuadOverlay({
  quad,
  width,
  height,
}: {
  quad: Quad;
  width: number;
  height: number;
}): ReactNode {
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <polygon
        points={quad.map((point) => `${point.x},${point.y}`).join(" ")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
