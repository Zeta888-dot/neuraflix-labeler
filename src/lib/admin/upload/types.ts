/**
 * Shared shapes for the browser text import. Everything here is serialisable:
 * server actions return these objects, and the client renders them.
 */

export type UploadFormat = "json" | "jsonl" | "csv";

export type ImportKind = "instruction" | "conversation";

export type ImportStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "abandoned";

export type UploadMeter = {
  usedBytes: number;
  quotaBytes: number;
  percent: number;
  warning: boolean;
  paused: boolean;
};

export type UploadQueue = {
  open: number;
  pauseAt: number;
  warning: boolean;
  paused: boolean;
};

export type UploadStatus = {
  generatedAt: string | null;
  db: UploadMeter;
  ocr: UploadMeter;
  instructions: UploadQueue;
  conversations: UploadQueue;
  ocrPool: UploadQueue;
  settings: {
    chunkRows: number;
    maxChunkBytes: number;
    warnPercent: number;
    openWarnPercent: number;
  };
};

export type ImportSource = {
  id: string;
  batchId: string | null;
  kind: string;
  fileName: string;
  fileSize: number;
  fileHash: string | null;
  sourceLabel: string | null;
  targetCount: number;
  chunkSize: number;
  status: ImportStatus;
  nextOffset: number;
  nextRow: number;
  nextChunkIndex: number;
  loadedRows: number;
  skippedRows: number;
  invalidRows: number;
  resumed: boolean;
  lastChunkIndex: number | null;
  lastChunkStart: number | null;
  lastChunkEnd: number | null;
  lastChunkHash: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type ImportErrorRow = {
  rowIndex: number;
  reason: string;
  detail: string | null;
  createdAt?: string | null;
};

export type ChunkResult = {
  loadedRows: number;
  skippedRows: number;
  invalidRows: number;
  nextOffset: number;
  nextRow: number;
  status: ImportStatus;
  alreadyCommitted: boolean;
  errors: ImportErrorRow[];
};

export type RawRow = {
  raw: string;
  rowIndex: number;
  byteLength: number;
};

export type RawChunk = {
  startOffset: number;
  endOffset: number;
  nextRow: number;
  rows: RawRow[];
  done: boolean;
};

export type ParsedRow = RawRow & {
  valid: boolean;
  reason: string | null;
  detail: string | null;
  hash: string | null;
};

export type ChunkPreview = {
  startOffset: number;
  endOffset: number;
  nextRow: number;
  done: boolean;
  contentHash: string;
  rows: ParsedRow[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  errors: ImportErrorRow[];
};

export type InstructionRow = {
  instruction: string;
  response: string;
  input: string | null;
  source: string | null;
};

export type ConversationRow = {
  turns: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  source: string | null;
};
