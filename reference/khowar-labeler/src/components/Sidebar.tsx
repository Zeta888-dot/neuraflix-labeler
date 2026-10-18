"use client";

import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileText,
  Languages,
  Loader2,
  Search,
  UploadCloud,
  X,
  XCircle,
} from "lucide-react";
import { exportDataset, uploadScans, type PageSummary } from "@/lib/api";

type Props = {
  pages: PageSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onUploaded: (created: string[]) => void;
};

type Status = { kind: "ok" | "err"; text: string } | null;

// Shape returned by POST /api/export (extra fields beyond what api.ts types today)
type ExportResult = {
  ok: true;
  count: number;
  path: string;
  url: string;
  train: number;
  val: number;
  pages: number;
  warnings: string[];
};

const FILTER_THRESHOLD = 6;

export default function Sidebar({ pages, activeId, onSelect, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [exportInfo, setExportInfo] = useState<ExportResult | null>(null);
  const [query, setQuery] = useState("");

  const totalLines = pages.reduce((n, p) => n + p.lines, 0);
  const totalLabeled = pages.reduce((n, p) => n + p.labeled, 0);
  const overallPct = totalLines ? (100 * totalLabeled) / totalLines : 0;

  const q = query.trim().toLowerCase();
  const visiblePages = q ? pages.filter((p) => p.id.toLowerCase().includes(q)) : pages;

  async function handleFiles(list: FileList | File[]) {
    const files = Array.from(list).filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      setStatus({ kind: "err", text: "Only image files (jpg / png) are allowed." });
      return;
    }
    setBusy(true);
    setStatus({ kind: "ok", text: `Processing ${files.length} scan(s)…` });
    try {
      const { created, errors } = await uploadScans(files);
      if (errors.length) {
        setStatus({
          kind: "err",
          text: errors.map((e) => `${e.name}: ${e.error}`).join(" | "),
        });
      } else {
        setStatus({ kind: "ok", text: `${created.length} page(s) ready` });
      }
      if (created.length) onUploaded(created);
    } catch (e) {
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Upload failed" });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleExport() {
    setBusy(true);
    setStatus(null);
    try {
      const r = (await exportDataset()) as ExportResult;
      setExportInfo(r);
    } catch (e) {
      setExportInfo(null);
      setStatus({ kind: "err", text: e instanceof Error ? e.message : "Export failed" });
    } finally {
      setBusy(false);
    }
  }

  const openPicker = () => !busy && inputRef.current?.click();

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900 text-neutral-100">
      {/* header */}
      <div className="border-b border-neutral-800 p-4">
        <h1 className="flex items-center gap-2 text-base font-semibold">
          <Languages className="h-5 w-5 text-blue-400" />
          Khowar Line Labeler
        </h1>
        <div className="mt-3 flex items-center justify-between text-xs text-neutral-400">
          <span>
            {totalLabeled} / {totalLines} lines labeled
          </span>
          <span className="tabular-nums">{Math.round(overallPct)}%</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all"
            style={{ width: `${overallPct}%` }}
          />
        </div>
        <p className="mt-2 text-xs text-neutral-500">{pages.length} page(s)</p>
      </div>

      {/* dropzone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload scans"
        aria-busy={busy}
        onClick={openPicker}
        onKeyDown={(e) => e.key === "Enter" && openPicker()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!busy) void handleFiles(e.dataTransfer.files);
        }}
        className={`m-3 cursor-pointer rounded-lg border-2 border-dashed p-4 text-center text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-blue-500 ${
          over
            ? "border-blue-500 bg-blue-500/10 text-neutral-100"
            : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
        } ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <div className="flex flex-col items-center gap-2">
          {busy ? (
            <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
          ) : (
            <UploadCloud
              className={`h-8 w-8 transition ${over ? "text-blue-400" : "text-neutral-500"}`}
            />
          )}
          <span>{busy ? "Working…" : "Drop scans or click to upload"}</span>
          {!busy && (
            <span className="text-xs text-neutral-500">
              JPG / PNG · each scan becomes a page
            </span>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => e.target.files && void handleFiles(e.target.files)}
        />
      </div>

      {/* status message */}
      {status && (
        <div
          role="status"
          className={`mx-3 mb-2 flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
            status.kind === "ok"
              ? "bg-emerald-500/10 text-emerald-300"
              : "bg-red-500/10 text-red-300"
          }`}
        >
          {status.kind === "ok" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 break-words">{status.text}</span>
          <button
            aria-label="Dismiss message"
            onClick={() => setStatus(null)}
            className="shrink-0 opacity-70 transition hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* export summary */}
      {exportInfo && (
        <div className="mx-3 mb-2 rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-medium text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              Export ready
            </span>
            <button
              aria-label="Dismiss export summary"
              onClick={() => setExportInfo(null)}
              className="text-neutral-500 transition hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <a
            href={exportInfo.url}
            download="khowar_dataset.zip"
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white outline-none transition hover:bg-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-300"
          >
            <Download className="h-4 w-4" />
            Download ZIP
          </a>
          <p className="mt-1 text-center text-[10px] text-neutral-500">
            Link valid for 1 hour · export again for a fresh one
          </p>

          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {[
              { label: "Train", value: exportInfo.train },
              { label: "Val", value: exportInfo.val },
              { label: "Pages", value: exportInfo.pages },
            ].map((s) => (
              <div key={s.label} className="rounded bg-neutral-900 py-1.5">
                <div className="text-sm font-semibold tabular-nums text-neutral-100">
                  {s.value}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                  {s.label}
                </div>
              </div>
            ))}
          </div>

          {exportInfo.warnings.length > 0 && (
            <div className="mt-2 rounded bg-amber-500/10 p-2">
              <p className="flex items-center gap-1.5 font-medium text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {exportInfo.warnings.length} character warning(s)
              </p>
              <ul className="mt-1 max-h-28 list-disc space-y-0.5 overflow-y-auto pl-5 text-amber-200/80">
                {exportInfo.warnings.map((w, i) => (
                  <li key={i} className="break-words">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* page filter (only when the list gets long) */}
      {pages.length > FILTER_THRESHOLD && (
        <div className="relative mx-3 mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter pages…"
            aria-label="Filter pages"
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 py-1.5 pl-8 pr-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-blue-500"
          />
        </div>
      )}

      {/* page list */}
      <nav className="flex-1 overflow-y-auto">
        {pages.length === 0 && <p className="p-4 text-xs text-neutral-500">No pages yet.</p>}
        {pages.length > 0 && visiblePages.length === 0 && (
          <p className="p-4 text-xs text-neutral-500">No pages match your filter.</p>
        )}
        {visiblePages.map((p) => {
          const done = p.lines > 0 && p.labeled === p.lines;
          const pct = p.lines ? (100 * p.labeled) / p.lines : 0;
          const active = p.id === activeId;
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p.id)}
              aria-current={active ? "page" : undefined}
              className={`flex w-full items-center gap-3 border-b border-l-2 border-b-neutral-800 px-4 py-3 text-left text-sm outline-none transition hover:bg-neutral-800 focus-visible:bg-neutral-800 ${
                active ? "border-l-blue-500 bg-neutral-800" : "border-l-transparent"
              }`}
            >
              {done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-neutral-500" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate" title={p.id}>
                    {p.id}
                  </span>
                  <span
                    className={`shrink-0 text-xs tabular-nums ${
                      done ? "text-emerald-400" : "text-neutral-400"
                    }`}
                  >
                    {p.labeled}/{p.lines}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded bg-neutral-700">
                  <div
                    className={`h-full ${done ? "bg-emerald-500" : "bg-blue-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </button>
          );
        })}
      </nav>

      {/* export */}
      <div className="border-t border-neutral-800 p-3">
        <button
          onClick={handleExport}
          disabled={busy || totalLabeled === 0}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white outline-none transition hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export for training
        </button>
        {totalLabeled === 0 && (
          <p className="mt-2 text-center text-xs text-neutral-500">
            Label at least one line to enable export.
          </p>
        )}
      </div>
    </aside>
  );
}