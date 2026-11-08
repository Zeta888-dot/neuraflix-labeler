"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/admin/upload/status";
import type { ImportSource, ImportStatus } from "@/lib/admin/upload/types";

function kindLabel(kind: string): string {
  if (kind === "conversation") return "Conversations";
  if (kind === "ocr_page") return "OCR pages";
  return "Instructions";
}

const statusLabels: Record<ImportStatus, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Complete",
  failed: "Failed",
  abandoned: "Stopped",
};

function statusTone(status: ImportStatus): "neutral" | "accent" | "error" {
  if (status === "failed" || status === "abandoned") return "error";
  if (status === "active" || status === "completed") return "accent";
  return "neutral";
}

function dateLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

export function SourceList({
  sources,
  busyId,
  onStatus,
  onDownload,
}: {
  sources: ImportSource[];
  busyId: string | null;
  onStatus: (source: ImportSource, status: "paused" | "active") => void;
  onDownload: (source: ImportSource) => void;
}) {
  return (
    <Card>
      <CardTitle>Recent uploads</CardTitle>
      <p className="mt-1 max-w-[65ch] text-body-sm text-body">
        Select the same file again to continue from its saved position. A
        paused file can be resumed here, but the file still has to be selected
        in this browser.
      </p>

      {sources.length === 0 ? (
        <p className="mt-5 rounded-md bg-surface-2/60 px-4 py-3 text-body-sm text-body">
          No uploads yet. Choose an instruction or conversation file above to
          start the first import.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {sources.map((source) => {
            const percent =
              source.fileSize > 0
                ? Math.min(
                    100,
                    Math.round((source.nextOffset / source.fileSize) * 100),
                  )
                : 0;
            const errorCount = source.invalidRows + source.skippedRows;
            const busy = busyId === source.id;

            return (
              <li
                key={source.id}
                className="rounded-md bg-surface-2/60 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-body-sm font-medium text-ink">
                      {source.fileName}
                    </p>
                    <p className="mt-1 text-caption text-mute">
                      {source.sourceLabel ?? "No label"} ·{" "}
                      {formatBytes(source.fileSize)} ·{" "}
                      {dateLabel(source.createdAt)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{kindLabel(source.kind)}</Badge>
                    <Badge tone={statusTone(source.status)}>
                      {statusLabels[source.status]}
                    </Badge>
                  </div>
                </div>

                <div
                  role="progressbar"
                  aria-label={`${source.fileName} bytes loaded`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-valuetext={`${percent} percent of the file read`}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-surface"
                >
                  <div
                    className={
                      source.status === "failed" ||
                      source.status === "abandoned"
                        ? "h-full rounded-full bg-error"
                        : "h-full rounded-full bg-accent"
                    }
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <dl className="mt-3 grid grid-cols-3 gap-2">
                  <div>
                    <dt className="text-caption text-mute">Loaded</dt>
                    <dd className="text-body-sm font-semibold text-ink">
                      {source.loadedRows.toLocaleString("en")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-caption text-mute">Skipped</dt>
                    <dd className="text-body-sm font-semibold text-ink">
                      {source.skippedRows.toLocaleString("en")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-caption text-mute">Invalid</dt>
                    <dd className="text-body-sm font-semibold text-ink">
                      {source.invalidRows.toLocaleString("en")}
                    </dd>
                  </div>
                </dl>

                {source.error ? (
                  <p className="mt-3 text-body-sm text-error">{source.error}</p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {source.status === "active" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => onStatus(source, "paused")}
                    >
                      Pause
                    </Button>
                  ) : null}

                  {source.status === "paused" ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => onStatus(source, "active")}
                    >
                      Resume
                    </Button>
                  ) : null}

                  {errorCount > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onDownload(source)}
                    >
                      Download errors
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
