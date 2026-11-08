"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import {
  allPauseMessages,
  formatBytes,
  formatPercent,
  textPauseMessages,
  warningMessages,
} from "@/lib/admin/upload/status";
import type {
  UploadMeter,
  UploadQueue,
  UploadStatus,
} from "@/lib/admin/upload/types";

function meterTone(meter: UploadMeter): "neutral" | "accent" | "error" {
  if (meter.paused) return "error";
  if (meter.warning) return "accent";
  return "neutral";
}

function queueTone(queue: UploadQueue): "neutral" | "accent" | "error" {
  if (queue.paused) return "error";
  if (queue.warning) return "accent";
  return "neutral";
}

function Meter({
  label,
  meter,
  note,
}: {
  label: string;
  meter: UploadMeter;
  note: string;
}) {
  const tone = meterTone(meter);
  const percent = Math.max(0, Math.min(100, meter.percent));
  const badge =
    tone === "error" ? "Paused" : tone === "accent" ? "Warning" : "OK";

  return (
    <div className="rounded-md bg-surface-2/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-sm font-medium text-ink">{label}</p>
        <Badge tone={tone}>{badge}</Badge>
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2">
        <div>
          <dt className="text-caption text-mute">Used</dt>
          <dd className="text-body-sm font-semibold text-ink">
            {formatBytes(meter.usedBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Quota</dt>
          <dd className="text-body-sm font-semibold text-ink">
            {formatBytes(meter.quotaBytes)}
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Share</dt>
          <dd className="text-body-sm font-semibold text-ink">
            {formatPercent(meter.percent)} percent
          </dd>
        </div>
      </dl>

      <div
        role="progressbar"
        aria-label={`${label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${formatPercent(meter.percent)} percent, ${formatBytes(meter.usedBytes)} of ${formatBytes(meter.quotaBytes)}`}
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface"
      >
        <div
          className={
            tone === "error"
              ? "h-full rounded-full bg-error"
              : "h-full rounded-full bg-accent"
          }
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="mt-2 text-caption text-mute">{note}</p>
    </div>
  );
}

function QueueStat({
  label,
  queue,
}: {
  label: string;
  queue: UploadQueue;
}) {
  const tone = queueTone(queue);
  const badge =
    tone === "error" ? "Paused" : tone === "accent" ? "Near limit" : "OK";

  return (
    <div className="rounded-md bg-surface-2/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-sm font-medium text-ink">{label}</p>
        <Badge tone={tone}>{badge}</Badge>
      </div>
      <p className="mt-3 text-display-sm font-semibold text-ink">
        {queue.open.toLocaleString("en")}
      </p>
      <p className="text-caption text-mute">
        Open items. Pause at {queue.pauseAt.toLocaleString("en")}.
      </p>
    </div>
  );
}

export function UploadStatusCard({ status }: { status: UploadStatus }) {
  const warnings = warningMessages(status);
  const paused = textPauseMessages(status).length > 0;
  const warning = !paused && warnings.length > 0;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>Storage and queues</CardTitle>
          <p className="mt-1 max-w-[65ch] text-body-sm text-body">
            Server side checks pause loading before the next chunk is written.
            These numbers refresh after every chunk.
          </p>
        </div>
        <Badge tone={paused ? "error" : warning ? "accent" : "neutral"}>
          {paused ? "Text paused" : warning ? "Warning" : "Ready"}
        </Badge>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        <Meter
          label="Database"
          meter={status.db}
          note="Text rows are not freed by export or purge."
        />
        <Meter
          label="OCR storage"
          meter={status.ocr}
          note="Encoded line images only. Original pages are never uploaded."
        />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <QueueStat label="Instructions" queue={status.instructions} />
        <QueueStat label="Conversations" queue={status.conversations} />
        <QueueStat label="OCR pool pages" queue={status.ocrPool} />
      </div>
    </Card>
  );
}

export function UploadNotices({ status }: { status: UploadStatus }) {
  const pauses = allPauseMessages(status);
  const warnings = warningMessages(status);
  const textPaused = textPauseMessages(status).length > 0;

  if (pauses.length === 0 && warnings.length === 0) return null;

  return (
    <div aria-live="polite" className="space-y-2">
      {pauses.length > 0 ? (
        <div
          role="status"
          className="rounded-md bg-surface-2 px-4 py-3 text-body-sm text-error"
        >
          <p className="font-medium">
            {textPaused ? "Text imports are paused" : "Some uploads are paused"}
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {pauses.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div
          role="status"
          className="rounded-md bg-surface-2 px-4 py-3 text-body-sm text-body"
        >
          <p className="font-medium text-ink">Quota warning</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {warnings.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
