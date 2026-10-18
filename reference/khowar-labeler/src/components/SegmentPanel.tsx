"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { ApiError, getPage, overlayUrl, resegment, type SegParams } from "@/lib/api";

type Props = {
  pageId: string;
  /** bump to bust the overlay image cache */
  version: number;
  /** called after a successful re-segmentation (parent reloads the page) */
  onResegmented: () => void;
};

type NumKey = "sensitivity" | "minHeight" | "mergeGap" | "pad";

// Mirrors DEFAULT_PARAMS in lib/segment.ts (not imported: that file pulls `sharp` into the bundle)
const DEFAULTS: SegParams = {
  deskew: true,
  sensitivity: 0.02,
  minHeight: 18,
  mergeGap: 6,
  pad: 6,
};

const PRESETS: { label: string; hint: string; params: Partial<SegParams> }[] = [
  { label: "Default", hint: "Factory settings", params: DEFAULTS },
  {
    label: "Catch faint dots",
    hint: "More sensitive, extra padding (diacritics / nuqtay getting cut)",
    params: { sensitivity: 0.01, mergeGap: 8, pad: 10 },
  },
  {
    label: "Tight lines",
    hint: "Less sensitive, small padding (lines merging together)",
    params: { sensitivity: 0.04, mergeGap: 3, pad: 4 },
  },
];

const SLIDERS: {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
}[] = [
  {
    key: "sensitivity",
    label: "Sensitivity",
    min: 0.005,
    max: 0.15,
    step: 0.005,
    hint: "Lower value = faint dots and diacritics are included in the line",
  },
  {
    key: "minHeight",
    label: "Min line height (px)",
    min: 5,
    max: 80,
    step: 1,
    hint: "Detected lines smaller than this are dropped as noise",
  },
  {
    key: "mergeGap",
    label: "Merge gap (px)",
    min: 0,
    max: 40,
    step: 1,
    hint: "Joins nearby bands (increase if a line is splitting)",
  },
  {
    key: "pad",
    label: "Padding (px)",
    min: 0,
    max: 30,
    step: 1,
    hint: "Margin around each crop",
  },
];

const fmt = (key: NumKey, v: number) => (key === "sensitivity" ? v.toFixed(3) : String(v));

function sameParams(a: SegParams, b: SegParams) {
  return (
    a.deskew === b.deskew &&
    a.sensitivity === b.sensitivity &&
    a.minHeight === b.minHeight &&
    a.mergeGap === b.mergeGap &&
    a.pad === b.pad
  );
}

function WipeDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="wipe-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 shadow-2xl"
      >
        <h3 id="wipe-title" className="flex items-center gap-2 text-base font-semibold">
          <AlertCircle className="h-5 w-5 text-red-400" />
          Re-segment and wipe labels?
        </h3>
        <p className="mt-2 text-sm text-neutral-400">
          This page already has typed labels. Re-segmenting creates new line images, so all
          existing labels on this page will be permanently deleted.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            onClick={onCancel}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none transition hover:border-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white outline-none transition hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300"
          >
            <RefreshCw className="h-4 w-4" />
            Re-segment &amp; wipe
          </button>
        </div>
      </div>
    </div>
  );
}

export default function SegmentPanel({ pageId, version, onResegmented }: Props) {
  const [loaded, setLoaded] = useState<SegParams | null>(null);
  const [params, setParams] = useState<SegParams | null>(null);
  const [angle, setAngle] = useState(0);
  const [lineCount, setLineCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [askWipe, setAskWipe] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPage(pageId)
      .then((p) => {
        if (cancelled) return;
        setLoaded(p.params);
        setParams(p.params);
        setAngle(p.angle);
        setLineCount(p.lines.length);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [pageId, version]);

  const dirty = !!params && !!loaded && !sameParams(params, loaded);

  async function run(force = false) {
    if (!params) return;
    setBusy(true);
    setError(null);
    try {
      await resegment(pageId, params, force);
      setAskWipe(false);
      onResegmented();
    } catch (e) {
      if (!force && e instanceof ApiError && e.status === 409) {
        setAskWipe(true);
      } else {
        setAskWipe(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-neutral-100">
      <summary className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300 outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        <SlidersHorizontal className="h-4 w-4" />
        Segmentation check &amp; re-segment
        {dirty && (
          <span className="ml-2 flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Settings changed
          </span>
        )}
      </summary>

      <div className="mt-4 space-y-4">
        <a
          href={overlayUrl(pageId, version)}
          target="_blank"
          rel="noreferrer"
          className="group relative block"
          title="Open full size in a new tab"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={overlayUrl(pageId, version)}
            alt="segmentation overlay"
            className="max-w-full rounded-md border border-neutral-800"
          />
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/60 px-2 py-1 text-xs text-neutral-200 opacity-0 transition group-hover:opacity-100">
            <ExternalLink className="h-3.5 w-3.5" />
            Full size
          </span>
        </a>

        <p className="text-xs text-neutral-400">
          {lineCount} lines detected · skew corrected by {angle.toFixed(2)}°
        </p>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1 break-words">{error}</span>
            <button
              aria-label="Dismiss error"
              onClick={() => setError(null)}
              className="opacity-70 transition hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {params ? (
          <>
            {/* presets */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-neutral-500">Presets:</span>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  title={p.hint}
                  onClick={() => setParams({ ...params, ...p.params })}
                  className="rounded-full border border-neutral-700 bg-neutral-800 px-3 py-1 text-xs text-neutral-200 outline-none transition hover:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={params.deskew}
                onChange={(e) => setParams({ ...params, deskew: e.target.checked })}
                className="accent-blue-500"
              />
              <RotateCw className="h-4 w-4 text-neutral-400" />
              Deskew (straighten tilted scans)
            </label>

            {SLIDERS.map((s) => (
              <div key={s.key}>
                <div className="flex items-center justify-between text-sm">
                  <label htmlFor={`seg-${s.key}`}>{s.label}</label>
                  <span className="tabular-nums text-neutral-400">
                    {fmt(s.key, params[s.key])}
                  </span>
                </div>
                <input
                  id={`seg-${s.key}`}
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={params[s.key]}
                  onChange={(e) => setParams({ ...params, [s.key]: Number(e.target.value) })}
                  className="w-full accent-blue-500"
                />
                <p className="text-xs text-neutral-500">{s.hint}</p>
              </div>
            ))}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => void run(false)}
                disabled={busy || !dirty}
                className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white outline-none transition hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {busy ? "Working…" : "Re-segment this page"}
              </button>
              <button
                onClick={() => loaded && setParams(loaded)}
                disabled={busy || !dirty}
                className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none transition hover:border-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RotateCcw className="h-4 w-4" />
                Reset
              </button>
              <span className="text-xs text-neutral-500">
                {dirty
                  ? "Labels are wiped on re-segment, so tune settings before typing."
                  : "Change a setting or pick a preset to re-segment."}
              </span>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings…
          </p>
        )}
      </div>

      {askWipe && <WipeDialog onCancel={() => setAskWipe(false)} onConfirm={() => void run(true)} />}
    </details>
  );
}