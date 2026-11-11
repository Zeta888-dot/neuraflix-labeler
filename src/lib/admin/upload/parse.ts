import type {
  ChunkResult,
  ImportDeletePreview,
  ImportDeleteResult,
  ImportErrorRow,
  ImportSource,
  ImportSourceItem,
  ImportStatus,
  UploadMeter,
  UploadQueue,
  UploadStatus,
} from "./types";

const STATUSES: readonly ImportStatus[] = [
  "active",
  "paused",
  "completed",
  "failed",
  "abandoned",
];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function statusValue(value: unknown): ImportStatus | null {
  return typeof value === "string" &&
    (STATUSES as readonly string[]).includes(value)
    ? (value as ImportStatus)
    : null;
}

export function parseImportSource(value: unknown): ImportSource | null {
  const row = record(value);
  if (!row) return null;

  // admin_import_create_source returns the id as source_id, while the list RPC
  // returns it as id. Accept both so a successful create is not read as a
  // failed request.
  const id = text(row.id) ?? text(row.source_id);
  const fileName = text(row.file_name);
  const status = statusValue(row.status);
  const fileSize = numberValue(row.file_size);

  if (!id || !fileName || !status || fileSize === null) return null;

  return {
    id,
    batchId: text(row.batch_id),
    kind: text(row.kind) ?? "instruction",
    fileName,
    fileSize,
    fileHash: text(row.file_hash),
    sourceLabel: text(row.source_label),
    targetCount: numberValue(row.target_count) ?? 1,
    chunkSize: numberValue(row.chunk_size) ?? 200,
    status,
    nextOffset: numberValue(row.next_offset) ?? 0,
    nextRow: numberValue(row.next_row) ?? 0,
    nextChunkIndex: numberValue(row.next_chunk_index) ?? 0,
    loadedRows: numberValue(row.loaded_rows) ?? 0,
    skippedRows: numberValue(row.skipped_rows) ?? 0,
    invalidRows: numberValue(row.invalid_rows) ?? 0,
    resumed: boolValue(row.resumed),
    lastChunkIndex: numberValue(row.last_chunk_index),
    lastChunkStart: numberValue(row.last_chunk_start),
    lastChunkEnd: numberValue(row.last_chunk_end),
    lastChunkHash: text(row.last_chunk_hash),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    completedAt: text(row.completed_at),
    error: text(row.error),
  };
}

export function parseImportDeletePreview(
  value: unknown,
): ImportDeletePreview | null {
  const row = record(value);
  if (!row) return null;

  const sourceId = text(row.source_id);
  const kind = text(row.kind);
  const fileName = text(row.file_name);
  const status = statusValue(row.status);
  if (!sourceId || !fileName || !status) return null;
  if (kind !== "instruction" && kind !== "conversation") return null;

  return {
    sourceId,
    kind,
    fileName,
    fileHash: text(row.file_hash),
    sourceLabel: text(row.source_label),
    status,
    totalItems: numberValue(row.total_items) ?? 0,
    openItems: numberValue(row.open_items) ?? 0,
    translatedItems: numberValue(row.translated_items) ?? 0,
    claimedItems: numberValue(row.claimed_items) ?? 0,
    reviewedItems: numberValue(row.reviewed_items) ?? 0,
    exportedItems: numberValue(row.exported_items) ?? 0,
    safeItems: numberValue(row.safe_items) ?? 0,
    protectedItems: numberValue(row.protected_items) ?? 0,
  };
}

export function parseImportSourceItem(value: unknown): ImportSourceItem | null {
  const row = record(value);
  if (!row) return null;

  const itemId = text(row.out_item_id);
  const status = text(row.out_status);
  if (!itemId || !status) return null;

  return {
    itemId,
    status,
    preview: text(row.out_preview) ?? "",
    translationCount: numberValue(row.out_translation_count) ?? 0,
    claimCount: numberValue(row.out_claim_count) ?? 0,
    reviewCount: numberValue(row.out_review_count) ?? 0,
    exportedCount: numberValue(row.out_exported_count) ?? 0,
    canDelete: boolValue(row.out_can_delete),
  };
}

export function parseImportDeleteResult(
  value: unknown,
): ImportDeleteResult | null {
  const row = record(value);
  if (!row) return null;

  return {
    deletedItems: numberValue(row.deleted_items) ?? 0,
    deletedTranslations: numberValue(row.deleted_translations) ?? 0,
    deletedExported: numberValue(row.deleted_exported) ?? 0,
    deletedClaims: numberValue(row.deleted_claims) ?? 0,
    deletedReviews: numberValue(row.deleted_reviews) ?? 0,
    remainingItems: numberValue(row.remaining_items) ?? 0,
    sourceRemoved: boolValue(row.source_removed),
  };
}

export function parseImportError(value: unknown): ImportErrorRow | null {
  const row = record(value);
  if (!row) return null;

  const rowIndex = numberValue(row.row_index);
  const reason = text(row.reason);
  if (rowIndex === null || !reason) return null;

  return {
    rowIndex,
    reason,
    detail: text(row.detail),
    createdAt: text(row.created_at),
  };
}

export function parseChunkResult(value: unknown): ChunkResult | null {
  const row = record(value);
  if (!row) return null;

  const status = statusValue(row.status);
  const nextOffset = numberValue(row.next_offset);
  const nextRow = numberValue(row.next_row);
  if (!status || nextOffset === null || nextRow === null) return null;

  const rawErrors = Array.isArray(row.errors) ? row.errors : [];

  return {
    loadedRows: numberValue(row.loaded_rows) ?? 0,
    skippedRows: numberValue(row.skipped_rows) ?? 0,
    invalidRows: numberValue(row.invalid_rows) ?? 0,
    nextOffset,
    nextRow,
    status,
    alreadyCommitted: boolValue(row.already_committed),
    errors: rawErrors
      .map(parseImportError)
      .filter((error): error is ImportErrorRow => error !== null),
  };
}

function parseMeter(value: unknown): UploadMeter | null {
  const row = record(value);
  if (!row) return null;

  const usedBytes = numberValue(row.used_bytes);
  const quotaBytes = numberValue(row.quota_bytes);
  const percent = numberValue(row.percent);
  if (usedBytes === null || quotaBytes === null || percent === null) {
    return null;
  }

  return {
    usedBytes,
    quotaBytes,
    percent,
    warning: boolValue(row.warning),
    paused: boolValue(row.paused),
  };
}

function parseQueue(value: unknown): UploadQueue | null {
  const row = record(value);
  if (!row) return null;

  const open = numberValue(row.open);
  const pauseAt = numberValue(row.pause_at);
  if (open === null || pauseAt === null) return null;

  return {
    open,
    pauseAt,
    warning: boolValue(row.warning),
    paused: boolValue(row.paused),
  };
}

export function parseUploadStatus(value: unknown): UploadStatus | null {
  const row = record(value);
  if (!row) return null;

  const db = parseMeter(row.db);
  const ocr = parseMeter(row.ocr);
  const instructions = parseQueue(row.instructions);
  const conversations = parseQueue(row.conversations);
  const ocrPool = parseQueue(row.ocr_pool);
  const settings = record(row.settings);

  if (
    !db ||
    !ocr ||
    !instructions ||
    !conversations ||
    !ocrPool ||
    !settings
  ) {
    return null;
  }

  const chunkRows = numberValue(settings.chunk_rows);
  const maxChunkBytes = numberValue(settings.max_chunk_bytes);
  const warnPercent = numberValue(settings.warn_percent);
  const openWarnPercent = numberValue(settings.open_warn_percent);

  if (
    chunkRows === null ||
    maxChunkBytes === null ||
    warnPercent === null ||
    openWarnPercent === null
  ) {
    return null;
  }

  return {
    generatedAt: text(row.generated_at),
    db,
    ocr,
    instructions,
    conversations,
    ocrPool,
    settings: { chunkRows, maxChunkBytes, warnPercent, openWarnPercent },
  };
}

export function parseImportErrorsPage(value: unknown): {
  totalCount: number;
  rows: ImportErrorRow[];
} {
  const rows = Array.isArray(value) ? value : [];
  let totalCount = 0;
  const parsed: ImportErrorRow[] = [];

  for (const item of rows) {
    const row = record(item);
    if (!row) continue;
    totalCount = Math.max(totalCount, numberValue(row.total_count) ?? 0);
    const error = parseImportError(row);
    if (error) parsed.push(error);
  }

  return { totalCount, rows: parsed };
}
