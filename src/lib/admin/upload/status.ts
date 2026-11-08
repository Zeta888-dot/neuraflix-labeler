import type { UploadStatus } from "./types";

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return `${Math.max(0, Math.min(100, Math.round(value)))}`;
}

/** Pause reasons that stop text imports. */
export function textPauseMessages(status: UploadStatus): string[] {
  const messages: string[] = [];

  if (status.db.paused) {
    messages.push(
      `The database is at ${formatPercent(status.db.percent)} percent of its ${formatBytes(status.db.quotaBytes)} quota. Text imports are paused. Archive data or raise the quota.`,
    );
  }

  if (status.instructions.paused) {
    messages.push(
      `Open instruction items are at ${status.instructions.open} of ${status.instructions.pauseAt}. Text imports are paused until items are completed or retired.`,
    );
  }

  return messages;
}

/** Every pause reason, including ones that do not stop text imports. */
export function allPauseMessages(status: UploadStatus): string[] {
  const messages = textPauseMessages(status);

  if (status.ocr.paused) {
    messages.push(
      `OCR storage is at ${formatPercent(status.ocr.percent)} percent of ${formatBytes(status.ocr.quotaBytes)}. OCR uploads are paused. Text imports still work.`,
    );
  }

  if (status.conversations.paused) {
    messages.push(
      `Open conversation items are at ${status.conversations.open} of ${status.conversations.pauseAt}. Conversation imports are paused. Instruction imports still work.`,
    );
  }

  if (status.ocrPool.paused) {
    messages.push(
      `Open OCR pool pages are at ${status.ocrPool.open} of ${status.ocrPool.pauseAt}. OCR pool uploads are paused. Text imports still work.`,
    );
  }

  return messages;
}

/** Warnings that do not pause loading. */
export function warningMessages(status: UploadStatus): string[] {
  const messages: string[] = [];

  if (status.db.warning && !status.db.paused) {
    messages.push(
      `The database is at ${formatPercent(status.db.percent)} percent of its quota.`,
    );
  }

  if (status.instructions.warning && !status.instructions.paused) {
    messages.push(
      `Open instruction items are at ${status.instructions.open} of ${status.instructions.pauseAt}.`,
    );
  }

  if (status.conversations.warning && !status.conversations.paused) {
    messages.push(
      `Open conversation items are at ${status.conversations.open} of ${status.conversations.pauseAt}.`,
    );
  }

  if (status.ocr.warning && !status.ocr.paused) {
    messages.push(
      `OCR storage is at ${formatPercent(status.ocr.percent)} percent of its quota.`,
    );
  }

  if (status.ocrPool.warning && !status.ocrPool.paused) {
    messages.push(
      `Open OCR pool pages are at ${status.ocrPool.open} of ${status.ocrPool.pauseAt}.`,
    );
  }

  return messages;
}

export function canLoadText(status: UploadStatus): boolean {
  return !status.db.paused && !status.instructions.paused;
}
