"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Loader2,
  Save,
  SkipForward,
  Trash2,
  X,
  ZoomIn,
} from "lucide-react";
import {
  deleteLine,
  deletePage,
  getPage,
  lineImageUrl,
  saveLabel,
  type PageDetail,
} from "@/lib/api";

type Props = {
  pageId: string;
  /** bump to force reload + bust image cache (e.g. after resegment) */
  version: number;
  onChanged: () => void;
  onPageDeleted: () => void;
  children?: ReactNode;
};

type Zoom = "fit" | 1 | 2;

type Confirm = {
  title: string;
  body: string;
  action: string;
  run: () => void | Promise<void>;
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ConfirmDialog({ c, onClose }: { c: Confirm; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-neutral-700 bg-neutral-900 p-5 text-neutral-100 shadow-2xl"
      >
        <h3 id="confirm-title" className="flex items-center gap-2 text-base font-semibold">
          <AlertCircle className="h-5 w-5 text-red-400" />
          {c.title}
        </h3>
        <p className="mt-2 text-sm text-neutral-400">{c.body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            autoFocus
            onClick={onClose}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none transition hover:border-neutral-500 focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              onClose();
              await c.run();
            }}
            className="flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white outline-none transition hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300"
          >
            <Trash2 className="h-4 w-4" />
            {c.action}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Workspace({
  pageId,
  version,
  onChanged,
  onPageDeleted,
  children,
}: Props) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [idx, setIdx] = useState(0);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [natW, setNatW] = useState(0);
  const [natH, setNatH] = useState(0);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // last text known to be saved on the server, per line (avoids duplicate PUTs)
  const savedRef = useRef<Record<number, string>>({});

  // Load page (parent remounts this component via `key` on page change)
  useEffect(() => {
    let cancelled = false;
    getPage(pageId)
      .then((p) => {
        if (cancelled) return;
        const first = p.lines.findIndex((l) => !l.label.trim());
        const start = first >= 0 ? first : 0;
        savedRef.current = Object.fromEntries(p.lines.map((l) => [l.i, l.label]));
        setPage(p);
        setIdx(start);
        setDraft(p.lines[start]?.label ?? "");
      })
      .catch((e) => !cancelled && setError(msg(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [pageId, version]);

  const line = page?.lines[idx];
  const curId = page?.id;

  // Keep typing focus on the box whenever the line changes
  useEffect(() => {
    taRef.current?.focus();
  }, [idx, curId]);

  const closeConfirm = useCallback(() => {
    setConfirm(null);
    setTimeout(() => taRef.current?.focus(), 0);
  }, []);

  const total = page?.lines.length ?? 0;
  const labeled = page ? page.lines.filter((l) => l.label.trim()).length : 0;
  const unsaved = !!line && draft.trim() !== line.label.trim();

  async function saveCurrent(): Promise<boolean> {
    if (!page || !line) return true;
    const known = savedRef.current[line.i] ?? line.label;
    if (draft.trim() === known.trim()) return true;
    setSaving(true);
    try {
      const saved = await saveLabel(page.id, line.i, draft);
      savedRef.current[line.i] = saved;
      setPage((prev) =>
        prev
          ? {
              ...prev,
              lines: prev.lines.map((l) => (l.i === line.i ? { ...l, label: saved } : l)),
            }
          : prev
      );
      setError(null);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 1500);
      onChanged();
      return true;
    } catch (e) {
      setError(`Save failed: ${msg(e)}`);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goTo(target: number) {
    if (!page) return;
    if (!(await saveCurrent())) return;
    const t = Math.max(0, Math.min(page.lines.length - 1, target));
    if (t === idx) return;
    setNotice(null);
    setIdx(t);
    setDraft(page.lines[t].label);
  }

  async function saveAndNext() {
    if (!page) return;
    if (idx < page.lines.length - 1) await goTo(idx + 1);
    else if (await saveCurrent()) setNotice("Page complete");
  }

  async function jumpUnlabeled() {
    if (!page || !page.lines.length) return;
    const n = page.lines.length;
    for (let step = 1; step <= n; step++) {
      const k = (idx + step) % n;
      if (!page.lines[k].label.trim() && k !== idx) {
        await goTo(k);
        return;
      }
    }
    setNotice("All lines are labeled");
  }

  async function removeLine() {
    if (!page || !line) return;
    try {
      await deleteLine(page.id, line.i);
      delete savedRef.current[line.i];
      const lines = page.lines.filter((l) => l.i !== line.i);
      const next = Math.min(idx, lines.length - 1);
      setPage({ ...page, lines });
      setIdx(Math.max(0, next));
      setDraft(lines[next]?.label ?? "");
      onChanged();
    } catch (e) {
      setError(`Delete failed: ${msg(e)}`);
    }
  }

  async function removePage() {
    if (!page) return;
    try {
      await deletePage(page.id);
      onPageDeleted();
    } catch (e) {
      setError(`Delete failed: ${msg(e)}`);
    }
  }

  function askRemoveLine() {
    if (!page || !line) return;
    setConfirm({
      title: `Delete line ${line.i}?`,
      body: "The line image and its label will be permanently removed.",
      action: "Delete line",
      run: removeLine,
    });
  }

  function askRemovePage() {
    if (!page) return;
    setConfirm({
      title: `Delete "${page.id}"?`,
      body: "All line images and labels of this page will be permanently removed.",
      action: "Delete page",
      run: removePage,
    });
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-neutral-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }
  if (!page) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-red-300">
        <AlertCircle className="h-4 w-4" />
        {error ?? "Page not found."}
      </div>
    );
  }

  const btn =
    "flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none transition hover:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="flex flex-col gap-4 p-6 text-neutral-100">
      {/* header */}
      <div className="flex items-center gap-4">
        <h2 className="truncate text-lg font-semibold" title={page.id}>
          {page.id}
        </h2>
        <span className="shrink-0 text-sm text-neutral-400">
          {total ? `line ${idx + 1}/${total}` : "no lines"} · {labeled} labeled
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-800">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: total ? `${(100 * labeled) / total}%` : "0%" }}
          />
        </div>
        <button
          onClick={askRemovePage}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 outline-none transition hover:border-red-500 hover:text-red-400 focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete page
        </button>
      </div>

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
      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            aria-label="Dismiss message"
            onClick={() => setNotice(null)}
            className="opacity-70 transition hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {line ? (
        <>
          {/* zoom + save status */}
          <div className="flex items-center gap-2 text-xs text-neutral-400">
            <ZoomIn className="h-4 w-4" />
            {(["fit", 1, 2] as Zoom[]).map((z) => (
              <button
                key={String(z)}
                onClick={() => setZoom(z)}
                aria-pressed={zoom === z}
                className={`rounded px-2 py-1 outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  zoom === z
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-800 text-neutral-300 hover:bg-neutral-700"
                }`}
              >
                {z === "fit" ? "Fit" : `${z}×`}
              </button>
            ))}
            {natW > 0 && (
              <span className="ml-2 tabular-nums text-neutral-500">
                {natW} × {natH} px
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5">
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : unsaved ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  Unsaved
                </>
              ) : justSaved ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  Saved
                </>
              ) : (
                <span className="text-neutral-500">line #{line.i}</span>
              )}
            </span>
          </div>

          {/* line image */}
          <div className="overflow-x-auto rounded-lg bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={`${page.id}-${line.i}-${version}`}
              src={lineImageUrl(page.id, line.i, version)}
              alt={`line ${line.i}`}
              onLoad={(e) => {
                setNatW(e.currentTarget.naturalWidth);
                setNatH(e.currentTarget.naturalHeight);
              }}
              style={
                zoom === "fit"
                  ? { width: "100%", height: "auto" }
                  : natW
                  ? { width: natW * zoom, maxWidth: "none", height: "auto" }
                  : undefined
              }
            />
          </div>

          {/* label box */}
          <div>
            <textarea
              ref={taRef}
              dir="rtl"
              lang="ur"
              rows={2}
              value={draft}
              spellCheck={false}
              aria-label={`Label for line ${line.i}`}
              placeholder="Type the label here… (Enter = save + next)"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void saveCurrent()}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveAndNext();
                } else if (e.altKey && e.key === "ArrowDown") {
                  e.preventDefault();
                  void goTo(idx + 1);
                } else if (e.altKey && e.key === "ArrowUp") {
                  e.preventDefault();
                  void goTo(idx - 1);
                }
              }}
              className="w-full resize-none rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-3 text-3xl leading-[2] outline-none focus:border-blue-500"
              style={{
                fontFamily:
                  '"Jameel Noori Nastaleeq","Noto Nastaliq Urdu","Noto Naskh Arabic",serif',
              }}
            />
            <p className="mt-1 text-right text-xs tabular-nums text-neutral-500">
              {Array.from(draft).length} chars
            </p>
          </div>

          {/* actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} onClick={() => void goTo(idx - 1)} disabled={idx === 0}>
              <ChevronLeft className="h-4 w-4" />
              Prev
            </button>
            <button
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white outline-none transition hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300"
              onClick={() => void saveAndNext()}
            >
              <Save className="h-4 w-4" />
              Save &amp; Next
            </button>
            <button
              className={btn}
              onClick={() => void goTo(idx + 1)}
              disabled={idx >= total - 1}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </button>
            <button className={btn} onClick={() => void jumpUnlabeled()}>
              <SkipForward className="h-4 w-4" />
              Next unlabeled
            </button>
            <button
              className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-100 outline-none transition hover:border-red-500 hover:text-red-400 focus-visible:ring-2 focus-visible:ring-red-500"
              onClick={askRemoveLine}
            >
              <Trash2 className="h-4 w-4" />
              Bad line
            </button>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500">
              <Keyboard className="h-3.5 w-3.5" />
              Enter: save + next · Alt+↓ / Alt+↑: next / prev
            </span>
          </div>

          {/* thumbnails */}
          <div className="flex flex-wrap gap-1.5">
            {page.lines.map((l, k) => (
              <button
                key={l.i}
                onClick={() => void goTo(k)}
                title={l.label.trim() ? l.label : "Not labeled yet"}
                aria-label={`Line ${l.i}${l.label.trim() ? ", labeled" : ", not labeled"}`}
                aria-current={k === idx ? "true" : undefined}
                className={`flex h-7 w-9 items-center justify-center rounded border text-xs outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  l.label.trim()
                    ? "border-emerald-600 bg-emerald-900/40 text-emerald-200"
                    : "border-neutral-700 bg-neutral-800 text-neutral-300"
                } ${k === idx ? "ring-2 ring-blue-500" : ""}`}
              >
                {l.i}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-neutral-700 p-6 text-sm text-neutral-400">
          <AlertCircle className="h-4 w-4 shrink-0" />
          No lines found on this page. Adjust the segmentation settings below and try again.
        </p>
      )}

      {children}

      {confirm && <ConfirmDialog c={confirm} onClose={closeConfirm} />}
    </div>
  );
}