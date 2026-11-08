"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  assertResumeAnchor,
  hashFile,
  ResumeMismatchError,
  sha256Hex,
} from "@/lib/admin/upload/hash";
import {
  DEFAULT_CHUNK_ROWS,
  DEFAULT_MAX_CHUNK_BYTES,
  readChunk,
} from "@/lib/admin/upload/line-chunks";
import {
  prepareFile,
  type PreparedSource,
} from "@/lib/admin/upload/prepare";
import {
  canLoadText,
  formatBytes,
  textPauseMessages,
} from "@/lib/admin/upload/status";
import type {
  ChunkPreview,
  ImportErrorRow,
  ImportKind,
  ImportSource,
  ImportStatus,
  UploadStatus,
} from "@/lib/admin/upload/types";
import { buildPreviewRows } from "@/lib/admin/upload/validate";
import { SourceList } from "./source-list";
import { UploadNotices, UploadStatusCard } from "./status-cards";
import {
  createImportSourceAction,
  downloadErrorCsvAction,
  getImportSourcesAction,
  getUploadStatusAction,
  loadTextChunkAction,
  setImportStatusAction,
  verifyResumeAnchorAction,
} from "./actions";

type Busy =
  | "hashing"
  | "creating"
  | "loading"
  | "status"
  | "csv"
  | null;

type Message = { tone: "error" | "info"; text: string };

const reasonLabels: Record<string, string> = {
  empty_row: "Empty row",
  invalid_json: "Not valid JSON",
  not_an_object: "Not an object",
  missing_instruction: "Missing instruction",
  empty_instruction: "Empty instruction",
  instruction_too_long: "Instruction too long",
  missing_response: "Missing response",
  response_too_long: "Response too long",
  invalid_input: "Input is not text",
  input_too_long: "Input too long",
  invalid_source: "Source is not text",
  source_too_long: "Source too long",
  missing_turns: "Missing turns",
  invalid_turns: "Turns is not an array",
  too_few_turns: "Fewer than 2 turns",
  too_many_turns: "More than 20 turns",
  invalid_turn: "A turn is not an object",
  invalid_role: "Unknown role",
  invalid_content: "Turn content is not text",
  missing_content: "A turn is empty",
  content_too_long: "A turn is over 4000 characters",
  system_not_first: "System turn is not first",
  multiple_system: "More than one system turn",
  roles_not_alternating: "User and assistant do not alternate",
  must_end_assistant: "Conversation does not end with assistant",
  row_too_large: "Row too large",
  duplicate_hash: "Duplicate of an earlier row",
  missing_raw: "Missing row data",
  insert_failed: "Database rejected the row",
};

function reasonLabel(reason: string): string {
  return reasonLabels[reason] ?? reason.replaceAll("_", " ");
}

function errorMessage(error: unknown): string {
  if (error instanceof ResumeMismatchError) return error.message;
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "The file could not be read. Check the format and try again.";
}

async function readPreview(
  preparedFile: PreparedSource,
  source: ImportSource,
  maxBytes: number,
): Promise<ChunkPreview> {
  const rawChunk = await readChunk(
    preparedFile.source,
    preparedFile.format,
    preparedFile.csvLayout,
    source.nextOffset,
    source.nextRow,
    { chunkRows: source.chunkSize, maxBytes },
  );

  const previewRows = await buildPreviewRows(
    rawChunk.rows,
    source.sourceLabel ?? preparedFile.originalName,
    source.kind === "conversation" ? "conversation" : "instruction",
  );

  const contentHash = await sha256Hex(
    await preparedFile.source.read(rawChunk.startOffset, rawChunk.endOffset),
  );

  return { ...rawChunk, contentHash, ...previewRows };
}

function MessageBanner({ message }: { message: Message }) {
  return (
    <div
      role={message.tone === "error" ? "alert" : "status"}
      aria-live="polite"
      className={
        message.tone === "error"
          ? "rounded-md bg-surface-2 px-4 py-3 text-body-sm text-error"
          : "rounded-md bg-surface-2 px-4 py-3 text-body-sm text-body"
      }
    >
      {message.text}
    </div>
  );
}

function CompletedCard({ source }: { source: ImportSource }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <CardTitle>Import complete</CardTitle>
        <Badge tone="accent">Complete</Badge>
      </div>
      <p className="mt-1 max-w-[65ch] text-body-sm text-body">
        Every row in this file has been processed. Selecting the same file again
        will not load it twice.
      </p>
      <dl className="mt-5 grid grid-cols-3 gap-3">
        <div>
          <dt className="text-caption text-mute">Loaded</dt>
          <dd className="text-display-sm font-semibold text-ink">
            {source.loadedRows.toLocaleString("en")}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Skipped duplicates</dt>
          <dd className="text-display-sm font-semibold text-ink">
            {source.skippedRows.toLocaleString("en")}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Invalid</dt>
          <dd className="text-display-sm font-semibold text-ink">
            {source.invalidRows.toLocaleString("en")}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function PreviewCard({
  source,
  preview,
  status,
  busy,
  errorTotal,
  onLoad,
  onPause,
  onDownload,
}: {
  source: ImportSource;
  preview: ChunkPreview;
  status: UploadStatus;
  busy: boolean;
  errorTotal: number;
  onLoad: () => void;
  onPause: () => void;
  onDownload: () => void;
}) {
  const canLoad = canLoadText(status);
  const paused = source.status === "paused";
  const firstRow = preview.rows[0]?.rowIndex ?? source.nextRow + 1;
  const lastRow = preview.rows[preview.rows.length - 1]?.rowIndex ?? source.nextRow;
  const rowRange =
    preview.rows.length === 0
      ? "No rows"
      : `${firstRow.toLocaleString("en")} to ${lastRow.toLocaleString("en")}`;
  const percent =
    source.fileSize > 0
      ? Math.min(100, Math.round((source.nextOffset / source.fileSize) * 100))
      : 0;
  const pauseMessages = textPauseMessages(status);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Next chunk</CardTitle>
          <p className="mt-1 max-w-[65ch] text-body-sm text-body">
            The browser has read this chunk. The server validates every row
            again before it writes.
          </p>
        </div>
        <Badge tone={paused ? "neutral" : "accent"}>
          {paused ? "Paused" : "Ready to load"}
        </Badge>
      </div>

      <div
        role="progressbar"
        aria-label="File bytes loaded"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent} percent of the file read`}
        className="mt-4 h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${percent}%` }}
        />
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-caption text-mute">Rows in chunk</dt>
          <dd className="text-body-sm font-semibold text-ink">
            {preview.rows.length.toLocaleString("en")}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Row range</dt>
          <dd className="text-body-sm font-semibold text-ink">{rowRange}</dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Valid</dt>
          <dd className="text-body-sm font-semibold text-ink">
            {preview.validCount.toLocaleString("en")}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Invalid or duplicate</dt>
          <dd className="text-body-sm font-semibold text-ink">
            {(preview.invalidCount + preview.duplicateCount).toLocaleString(
              "en",
            )}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-caption text-mute">
        Bytes {preview.startOffset.toLocaleString("en")} to{" "}
        {preview.endOffset.toLocaleString("en")} of{" "}
        {source.fileSize.toLocaleString("en")}. Chunk hash{" "}
        {preview.contentHash.slice(0, 12)}.
      </p>

      {source.resumed ? (
        <p className="mt-2 text-body-sm text-body">
          Resuming at row {source.nextRow + 1}, byte {source.nextOffset}.
        </p>
      ) : null}

      {paused ? (
        <p className="mt-3 rounded-md bg-surface-2/60 px-3 py-2 text-body-sm text-body">
          This import is paused. Resume and load will set it active before the
          chunk is sent.
        </p>
      ) : null}

      {!canLoad ? (
        <div className="mt-3 rounded-md bg-surface-2/60 px-3 py-2 text-body-sm text-error">
          <p className="font-medium">The server is pausing text imports.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {pauseMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.rows.length === 0 && preview.done ? (
        <p className="mt-3 rounded-md bg-surface-2/60 px-3 py-2 text-body-sm text-body">
          This chunk has no data rows. It only advances to the end of the file,
          so loading it marks the import complete.
        </p>
      ) : null}

      {preview.errors.length > 0 ? (
        <div className="mt-3 rounded-md bg-surface-2/60 p-3">
          <p className="text-body-sm font-medium text-ink">
            First errors in this chunk
          </p>
          <ul className="mt-2 space-y-1">
            {preview.errors.map((error) => (
              <li key={`${error.rowIndex}-${error.reason}`} className="text-body-sm text-body">
                Row {error.rowIndex}: {reasonLabel(error.reason)}
                {error.detail ? (
                  <span className="ml-1 break-all text-caption text-mute">
                    {error.detail}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={onLoad}
          disabled={busy || !canLoad || source.status === "completed"}
        >
          {busy
            ? "Working..."
            : paused
              ? "Resume and load next chunk"
              : "Load next chunk"}
        </Button>

        {source.status === "active" ? (
          <Button variant="secondary" onClick={onPause} disabled={busy}>
            Pause import
          </Button>
        ) : null}

        {errorTotal > 0 ? (
          <Button variant="ghost" onClick={onDownload} disabled={busy}>
            Download error CSV
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function ErrorsCard({
  errors,
  total,
  busy,
  onDownload,
}: {
  errors: ImportErrorRow[];
  total: number;
  busy: boolean;
  onDownload: () => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Row errors</CardTitle>
          <p className="mt-1 max-w-[65ch] text-body-sm text-body">
            Invalid rows and duplicate hashes are logged. They do not stop the
            chunk. The CSV prefixes formula characters so it is safe to open in
            a spreadsheet.
          </p>
        </div>
        <Badge tone={total > 0 ? "accent" : "neutral"}>
          {total.toLocaleString("en")} total
        </Badge>
      </div>

      {errors.length === 0 ? (
        <p className="mt-4 rounded-md bg-surface-2/60 px-3 py-2 text-body-sm text-body">
          No new row errors in the last chunk. Download the CSV to see earlier
          rows.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-hairline">
          {errors.map((error) => (
            <li
              key={`${error.rowIndex}-${error.reason}`}
              className="flex flex-wrap items-baseline gap-2 py-2"
            >
              <span className="text-body-sm font-medium text-ink">
                Row {error.rowIndex}
              </span>
              <span className="text-body-sm text-body">
                {reasonLabel(error.reason)}
              </span>
              {error.detail ? (
                <span className="break-all text-caption text-mute">
                  {error.detail}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <Button variant="secondary" size="sm" onClick={onDownload} disabled={busy}>
          Download error CSV
        </Button>
      </div>
    </Card>
  );
}

export function UploadWorkspace({
  initialStatus,
  initialSources,
}: {
  initialStatus: UploadStatus | null;
  initialSources: ImportSource[];
}) {
  const [status, setStatus] = useState<UploadStatus | null>(initialStatus);
  const [sources, setSources] = useState<ImportSource[]>(initialSources);
  const [kind, setKind] = useState<ImportKind>("instruction");
  const [busy, setBusy] = useState<Busy>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [prepared, setPrepared] = useState<PreparedSource | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  const [hashProgress, setHashProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [source, setSource] = useState<ImportSource | null>(null);
  const [preview, setPreview] = useState<ChunkPreview | null>(null);
  const [errors, setErrors] = useState<ImportErrorRow[]>([]);
  const [errorTotal, setErrorTotal] = useState(0);
  const [sourceLabel, setSourceLabel] = useState("");
  const [targetCount, setTargetCount] = useState(1);
  const [chunkRows, setChunkRows] = useState(
    initialStatus?.settings.chunkRows ?? DEFAULT_CHUNK_ROWS,
  );
  const runIdRef = useRef(0);

  const maxChunkBytes =
    status?.settings.maxChunkBytes && status.settings.maxChunkBytes > 0
      ? status.settings.maxChunkBytes
      : DEFAULT_MAX_CHUNK_BYTES;

  async function refreshAll(): Promise<void> {
    const [statusResult, sourcesResult] = await Promise.all([
      getUploadStatusAction(),
      getImportSourcesAction(),
    ]);

    if (statusResult.status === "ok") setStatus(statusResult.uploadStatus);
    if (sourcesResult.status === "ok") setSources(sourcesResult.sources);
  }

  function resetSelection(): void {
    runIdRef.current += 1;
    setFile(null);
    setPrepared(null);
    setFileHash(null);
    setHashProgress(null);
    setSource(null);
    setPreview(null);
    setErrors([]);
    setErrorTotal(0);
    setMessage(null);
    setBusy(null);
    setBusySourceId(null);
  }

  async function handleRetry(): Promise<void> {
    setBusy("status");
    setMessage(null);
    await refreshAll();
    setBusy(null);
  }

  async function handleFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const selected = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!selected) return;

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    setFile(selected);
    setPrepared(null);
    setFileHash(null);
    setHashProgress(null);
    setSource(null);
    setPreview(null);
    setErrors([]);
    setErrorTotal(0);
    setMessage(null);
    setBusy("hashing");

    const safeTarget = Math.min(5, Math.max(1, Math.trunc(targetCount) || 1));
    const safeChunkRows = Math.min(
      1000,
      Math.max(20, Math.trunc(chunkRows) || DEFAULT_CHUNK_ROWS),
    );
    setTargetCount(safeTarget);
    setChunkRows(safeChunkRows);

    const label =
      sourceLabel.trim() || selected.name.replace(/\.[^.]+$/, "");
    if (!sourceLabel.trim()) setSourceLabel(label);

    try {
      const preparedFile = await prepareFile(selected);
      if (runId !== runIdRef.current) return;
      setPrepared(preparedFile);

      if (preparedFile.source.size < 1) {
        throw new Error("The file has no data rows.");
      }
      if (preparedFile.source.size > 209_715_200) {
        throw new Error(
          "The file is larger than 200 MB. Split it before importing.",
        );
      }

      const hash = await hashFile(preparedFile.hashSource, (done, total) => {
        if (runId === runIdRef.current) setHashProgress({ done, total });
      });
      if (runId !== runIdRef.current) return;
      setFileHash(hash);
      setHashProgress(null);
      setBusy("creating");

      const created = await createImportSourceAction({
        kind,
        fileName: selected.name,
        fileSize: preparedFile.source.size,
        fileHash: hash,
        sourceLabel: label,
        targetCount: safeTarget,
        chunkSize: safeChunkRows,
      });
      if (runId !== runIdRef.current) return;

      if (created.status === "error") {
        setMessage({ tone: "error", text: created.message });
        setBusy(null);
        return;
      }

      const nextSource = created.source;
      setSource(nextSource);
      if (nextSource.kind === "instruction" || nextSource.kind === "conversation") {
        setKind(nextSource.kind);
      }
      setChunkRows(nextSource.chunkSize);

      if (nextSource.status === "completed") {
        setErrorTotal(nextSource.invalidRows + nextSource.skippedRows);
        setMessage({
          tone: "info",
          text: "This file is already complete. The rows were not loaded again.",
        });
        setBusy(null);
        await refreshAll();
        return;
      }

      if (nextSource.status === "failed" || nextSource.status === "abandoned") {
        setErrorTotal(nextSource.invalidRows + nextSource.skippedRows);
        setMessage({
          tone: "error",
          text: "This import is closed. Select a new file.",
        });
        setBusy(null);
        await refreshAll();
        return;
      }

      if (
        nextSource.resumed &&
        nextSource.lastChunkIndex !== null &&
        nextSource.lastChunkStart !== null &&
        nextSource.lastChunkEnd !== null &&
        nextSource.lastChunkHash
      ) {
        const anchorBytes = await preparedFile.source.read(
          nextSource.lastChunkStart,
          nextSource.lastChunkEnd,
        );
        const anchorHash = await sha256Hex(anchorBytes);
        if (runId !== runIdRef.current) return;

        const verified = await verifyResumeAnchorAction({
          sourceId: nextSource.id,
          chunkIndex: nextSource.lastChunkIndex,
          startOffset: nextSource.lastChunkStart,
          endOffset: nextSource.lastChunkEnd,
          contentHash: anchorHash,
        });
        if (runId !== runIdRef.current) return;

        if (verified.status === "error") {
          setMessage({ tone: "error", text: verified.message });
          setBusy(null);
          return;
        }

        if (!verified.matched) {
          assertResumeAnchor(nextSource.lastChunkHash, anchorHash);
        }
      }

      const nextPreview = await readPreview(
        preparedFile,
        nextSource,
        maxChunkBytes,
      );
      if (runId !== runIdRef.current) return;

      setPreview(nextPreview);
      setErrors(nextPreview.errors);
      setErrorTotal(nextSource.invalidRows + nextSource.skippedRows);

      if (nextSource.resumed) {
        setMessage({
          tone: "info",
          text: `Resuming at row ${nextSource.nextRow + 1}, byte ${nextSource.nextOffset}.`,
        });
      }

      setBusy(null);
      void refreshAll();
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setMessage({ tone: "error", text: errorMessage(error) });
      setBusy(null);
    }
  }

  async function handleLoadChunk(): Promise<void> {
    if (!source || !preview || busy !== null) return;

    const runId = runIdRef.current;
    setBusy("loading");
    setMessage(null);

    try {
      let activeSource = source;

      if (activeSource.status === "paused") {
        const resumed = await setImportStatusAction({
          sourceId: activeSource.id,
          status: "active",
        });
        if (runId !== runIdRef.current) return;

        if (resumed.status === "error") {
          setMessage({ tone: "error", text: resumed.message });
          setBusy(null);
          return;
        }

        activeSource = { ...activeSource, status: "active" };
        setSource(activeSource);
      }

      const loaded = await loadTextChunkAction({
        sourceId: activeSource.id,
        chunkIndex: activeSource.nextChunkIndex,
        startOffset: preview.startOffset,
        endOffset: preview.endOffset,
        contentHash: preview.contentHash,
        rows: preview.rows.map((row) => ({ raw: row.raw })),
      });
      if (runId !== runIdRef.current) return;

      if (loaded.status === "error") {
        setMessage({ tone: "error", text: loaded.message });
        setBusy(null);
        await refreshAll();
        return;
      }

      const chunk = loaded.result;
      const updated: ImportSource = {
        ...activeSource,
        status: chunk.status,
        nextOffset: chunk.nextOffset,
        nextRow: chunk.nextRow,
        nextChunkIndex: activeSource.nextChunkIndex + 1,
        loadedRows: activeSource.loadedRows + chunk.loadedRows,
        skippedRows: activeSource.skippedRows + chunk.skippedRows,
        invalidRows: activeSource.invalidRows + chunk.invalidRows,
      };

      setSource(updated);
      setErrors(chunk.errors);
      setErrorTotal(updated.invalidRows + updated.skippedRows);

      await refreshAll();
      if (runId !== runIdRef.current) return;

      if (chunk.status === "completed") {
        setPreview(null);
        setMessage({
          tone: "info",
          text: `Import complete. ${updated.loadedRows.toLocaleString("en")} rows loaded, ${updated.skippedRows.toLocaleString("en")} duplicates skipped, ${updated.invalidRows.toLocaleString("en")} invalid.`,
        });
        setBusy(null);
        return;
      }

      if (chunk.alreadyCommitted) {
        setMessage({
          tone: "info",
          text: "This chunk was already saved. Continuing from the saved position.",
        });
      }

      if (!prepared) {
        setMessage({
          tone: "error",
          text: "Select the same file again to continue this import.",
        });
        setBusy(null);
        return;
      }

      const nextPreview = await readPreview(prepared, updated, maxChunkBytes);
      if (runId !== runIdRef.current) return;
      setPreview(nextPreview);
      setBusy(null);
    } catch (error) {
      if (runId !== runIdRef.current) return;
      setMessage({ tone: "error", text: errorMessage(error) });
      setBusy(null);
    }
  }

  async function handlePause(): Promise<void> {
    if (!source || source.status !== "active" || busy !== null) return;

    setBusy("status");
    setMessage(null);

    try {
      const result = await setImportStatusAction({
        sourceId: source.id,
        status: "paused",
      });

      if (result.status === "error") {
        setMessage({ tone: "error", text: result.message });
      } else {
        setSource({ ...source, status: "paused" });
        setMessage({
          tone: "info",
          text: "Import paused. Select the same file to continue later.",
        });
        await refreshAll();
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleSourceStatus(
    target: ImportSource,
    nextStatus: "paused" | "active",
  ): Promise<void> {
    setBusySourceId(target.id);
    setMessage(null);

    try {
      const result = await setImportStatusAction({
        sourceId: target.id,
        status: nextStatus,
      });

      if (result.status === "error") {
        setMessage({ tone: "error", text: result.message });
        return;
      }

      const statusValue = result.sourceStatus as ImportStatus;
      setSources((current) =>
        current.map((item) =>
          item.id === target.id ? { ...item, status: statusValue } : item,
        ),
      );

      if (source?.id === target.id) {
        setSource((current) =>
          current ? { ...current, status: statusValue } : current,
        );
      }

      if (nextStatus === "active") {
        setMessage({
          tone: "info",
          text:
            source?.id === target.id && preview
              ? "Import resumed. Click Load next chunk to continue."
              : "Import resumed. Select the same file to continue.",
        });
      } else {
        setMessage({ tone: "info", text: "Import paused." });
      }

      await refreshAll();
    } finally {
      setBusySourceId(null);
    }
  }

  async function handleDownload(target: ImportSource): Promise<void> {
    setBusySourceId(target.id);
    setMessage(null);

    try {
      const result = await downloadErrorCsvAction({
        sourceId: target.id,
        fileName: target.fileName,
      });

      if (result.status === "error") {
        setMessage({ tone: "error", text: result.message });
        return;
      }

      if (result.status === "empty") {
        setMessage({ tone: "info", text: "There are no row errors to download." });
        return;
      }

      const blob = new Blob([result.csv], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "info", text: "The error report was downloaded." });
    } finally {
      setBusySourceId(null);
    }
  }

  if (!status) {
    return (
      <div className="space-y-4">
        {message ? <MessageBanner message={message} /> : null}
        <Card>
          <CardTitle>Upload status could not be read</CardTitle>
          <p className="mt-2 max-w-[65ch] text-body-sm text-body">
            Apply 0010_import_text.sql in the Supabase SQL editor, then reload
            this page. If the migration is applied, check the server log for the
            RPC error.
          </p>
          <div className="mt-4">
            <Button onClick={handleRetry} disabled={busy !== null}>
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const previewBusy = busy !== null || busySourceId === source?.id;

  return (
    <div className="space-y-6">
      {message ? <MessageBanner message={message} /> : null}
      <UploadNotices status={status} />
      <UploadStatusCard status={status} />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>
              {kind === "conversation"
                ? "Conversation data"
                : "Instruction and response data"}
            </CardTitle>
            <p className="mt-1 max-w-[65ch] text-body-sm text-body">
              Load a JSON, JSON Lines or CSV file in chunks. Duplicate rows are
              skipped by english_hash. Invalid rows are logged and do not stop
              the chunk.
            </p>
          </div>
          <Badge tone="accent">
            {kind === "conversation" ? "Conversations" : "Instructions"}
          </Badge>
        </div>

        <div
          role="group"
          aria-label="Dataset"
          className="mt-4 flex flex-wrap gap-2"
        >
          {(["instruction", "conversation"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              onClick={() => setKind(option)}
              disabled={source !== null || busy !== null}
              className={
                kind === option
                  ? "inline-flex min-h-11 items-center rounded-full bg-solid px-4 text-body-sm font-medium text-on-solid disabled:opacity-60"
                  : "inline-flex min-h-11 items-center rounded-full bg-surface-2 px-4 text-body-sm font-medium text-body hover:text-ink disabled:opacity-60"
              }
            >
              {option === "conversation" ? "Conversations" : "Instructions"}
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-body-sm text-body">
            Source label
            <Input
              value={sourceLabel}
              onChange={(event) => setSourceLabel(event.target.value)}
              placeholder={
                kind === "conversation"
                  ? "For example, english-conversations-v1"
                  : "For example, english-instructions-v1"
              }
              maxLength={120}
              disabled={source !== null || busy !== null}
            />
          </label>

          <label className="flex flex-col gap-1 text-body-sm text-body">
            Target count
            <Input
              type="number"
              min={1}
              max={5}
              value={targetCount}
              onChange={(event) =>
                setTargetCount(Number(event.target.value) || 1)
              }
              disabled={source !== null || busy !== null}
            />
          </label>

          <label className="flex flex-col gap-1 text-body-sm text-body">
            Rows per chunk
            <Input
              type="number"
              min={20}
              max={1000}
              value={chunkRows}
              onChange={(event) =>
                setChunkRows(
                  Number(event.target.value) || DEFAULT_CHUNK_ROWS,
                )
              }
              disabled={source !== null || busy !== null}
            />
          </label>
        </div>

        <p className="mt-2 text-caption text-mute">
          The label, target count and chunk size are fixed when an import
          starts. Chunks stop at {formatBytes(status.settings.maxChunkBytes)} or
          the row limit, whichever comes first.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label
            className={buttonClasses({
              variant: "secondary",
              size: "md",
              className:
                busy !== null
                  ? "pointer-events-none opacity-50"
                  : "cursor-pointer",
            })}
          >
            Choose a file
            <input
              type="file"
              accept=".json,.jsonl,.csv,application/json,application/x-ndjson,text/csv"
              className="sr-only"
              onChange={handleFileChange}
              disabled={busy !== null}
            />
          </label>

          {source ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={resetSelection}
              disabled={busy !== null}
            >
              Clear selection
            </Button>
          ) : null}

          <span className="text-caption text-mute">
            .json, .jsonl or .csv. The file is read in this browser.
          </span>
        </div>

        {busy === "hashing" && !hashProgress ? (
          <p className="mt-3 text-body-sm text-body">Reading the file...</p>
        ) : null}

        {busy === "creating" ? (
          <p className="mt-3 text-body-sm text-body">Creating the import...</p>
        ) : null}

        {busy === "hashing" && hashProgress ? (
          <div className="mt-4">
            <p className="text-body-sm text-body">
              Hashing {formatBytes(hashProgress.done)} of{" "}
              {formatBytes(hashProgress.total)}
            </p>
            <div
              role="progressbar"
              aria-label="File hash progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                hashProgress.total > 0
                  ? Math.round((hashProgress.done / hashProgress.total) * 100)
                  : 0
              }
              className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2"
            >
              <div
                className="h-full rounded-full bg-accent"
                style={{
                  width: `${
                    hashProgress.total > 0
                      ? Math.min(
                          100,
                          Math.round(
                            (hashProgress.done / hashProgress.total) * 100,
                          ),
                        )
                      : 0
                  }%`,
                }}
              />
            </div>
          </div>
        ) : null}

        {prepared ? (
          <div className="mt-4 rounded-md bg-surface-2/60 p-4">
            <dl className="grid gap-3 sm:grid-cols-4">
              <div>
                <dt className="text-caption text-mute">File</dt>
                <dd className="break-words text-body-sm font-semibold text-ink">
                  {prepared.originalName}
                </dd>
              </div>
              <div>
                <dt className="text-caption text-mute">Format</dt>
                <dd className="text-body-sm font-semibold text-ink">
                  {prepared.format === "csv"
                    ? "CSV"
                    : prepared.format === "json"
                      ? "JSON array"
                      : "JSON Lines"}
                </dd>
              </div>
              <div>
                <dt className="text-caption text-mute">Original size</dt>
                <dd className="text-body-sm font-semibold text-ink">
                  {formatBytes(prepared.originalSize)}
                </dd>
              </div>
              <div>
                <dt className="text-caption text-mute">Read size</dt>
                <dd className="text-body-sm font-semibold text-ink">
                  {formatBytes(prepared.source.size)}
                </dd>
              </div>
            </dl>

            {prepared.note ? (
              <p className="mt-2 text-caption text-mute">{prepared.note}</p>
            ) : null}

            {file && prepared.originalSize !== prepared.source.size ? (
              <p className="mt-1 text-caption text-mute">
                Saved offsets refer to the converted read size.
              </p>
            ) : null}

            {fileHash ? (
              <p className="mt-2 break-all text-caption text-mute">
                File hash {fileHash}
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      {source && source.status === "completed" ? (
        <CompletedCard source={source} />
      ) : null}

      {preview && source && source.status !== "completed" ? (
        <PreviewCard
          source={source}
          preview={preview}
          status={status}
          busy={previewBusy}
          errorTotal={errorTotal}
          onLoad={handleLoadChunk}
          onPause={handlePause}
          onDownload={() => handleDownload(source)}
        />
      ) : null}

      {errorTotal > 0 ? (
        <ErrorsCard
          errors={errors}
          total={errorTotal}
          busy={busy !== null || busySourceId === source?.id}
          onDownload={() => {
            if (source) handleDownload(source);
          }}
        />
      ) : null}

      <SourceList
        sources={sources}
        busyId={busySourceId}
        onStatus={handleSourceStatus}
        onDownload={handleDownload}
      />
    </div>
  );
}
