/**
 * Byte-offset chunk reader for JSON Lines and CSV.
 *
 * The browser never loads the whole file. A chunk ends on a row boundary and
 * carries the exact byte range that the database stores and hashes. JSON array
 * files are converted to JSON Lines in memory by prepare.ts and read with the
 * same JSONL reader.
 */

import { CsvError, csvRecordToRaw, findCsvRecord, type CsvLayout } from "./csv";
import type { ByteSource } from "./hash";
import type { RawChunk, RawRow, UploadFormat } from "./types";

export const DEFAULT_CHUNK_ROWS = 200;
export const MAX_CHUNK_ROWS = 1000;
export const DEFAULT_MAX_CHUNK_BYTES = 700 * 1024;
export const SCAN_WINDOW_BYTES = 8 * 1024 * 1024;

export type ReadChunkOptions = {
  chunkRows: number;
  maxBytes: number;
};

export class ChunkReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkReadError";
  }
}

export class RowTooLargeError extends ChunkReadError {
  readonly rowIndex: number;
  readonly byteLength: number;

  constructor(rowIndex: number, byteLength: number) {
    super(
      `Row ${rowIndex} is ${Math.round(byteLength / 1024)} KB, larger than the chunk limit. Split the row or use a smaller file.`,
    );
    this.name = "RowTooLargeError";
    this.rowIndex = rowIndex;
    this.byteLength = byteLength;
  }
}

function indexOfByte(bytes: Uint8Array, value: number, from: number): number {
  for (let index = from; index < bytes.length; index += 1) {
    if (bytes[index] === value) return index;
  }
  return -1;
}

function isBlank(bytes: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false;
  }
  return true;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function cleanRaw(raw: string, rowIndex: number): string {
  if (rowIndex === 0 && raw.charCodeAt(0) === 0xfeff) {
    return raw.slice(1);
  }
  return raw;
}

function emptyChunk(
  startOffset: number,
  nextRow: number,
  size: number,
): RawChunk {
  return {
    startOffset,
    endOffset: size,
    nextRow,
    rows: [],
    done: true,
  };
}

/** Reads one chunk from a JSON Lines byte source. */
export async function readJsonlChunk(
  source: ByteSource,
  startOffset: number,
  nextRow: number,
  options: ReadChunkOptions,
): Promise<RawChunk> {
  if (startOffset >= source.size) {
    return emptyChunk(startOffset, nextRow, source.size);
  }

  const windowEnd = Math.min(source.size, startOffset + SCAN_WINDOW_BYTES);
  const bytes = await source.read(startOffset, windowEnd);
  if (bytes.length === 0) {
    return emptyChunk(startOffset, nextRow, source.size);
  }

  const rows: RawRow[] = [];
  let cursor = 0;
  let lastEnd = startOffset;
  let rowIndex = nextRow;
  let rawBytes = 0;

  while (cursor < bytes.length) {
    const newline = indexOfByte(bytes, 0x0a, cursor);
    const lineEnd = newline === -1 ? bytes.length : newline;
    const next = newline === -1 ? bytes.length : newline + 1;
    const partial = newline === -1 && windowEnd < source.size;

    if (partial) {
      if (rows.length === 0) {
        throw new ChunkReadError(
          "A line in this part of the file is longer than 8 MB. Split the file before importing it.",
        );
      }
      break;
    }

    let contentEnd = lineEnd;
    if (contentEnd > cursor && bytes[contentEnd - 1] === 0x0d) {
      contentEnd -= 1;
    }

    if (!isBlank(bytes, cursor, contentEnd)) {
      const byteLength = contentEnd - cursor;

      if (rows.length === 0 && byteLength > options.maxBytes) {
        throw new RowTooLargeError(rowIndex + 1, byteLength);
      }

      if (
        rows.length > 0 &&
        (rows.length >= options.chunkRows ||
          rawBytes + byteLength > options.maxBytes)
      ) {
        break;
      }

      const raw = cleanRaw(decode(bytes.subarray(cursor, contentEnd)), rowIndex);
      rows.push({
        raw,
        rowIndex: rowIndex + 1,
        byteLength,
      });
      rawBytes += byteLength;
      rowIndex += 1;
      lastEnd = startOffset + next;
    } else {
      lastEnd = startOffset + next;
    }

    cursor = next;

    if (rows.length >= options.chunkRows || rawBytes >= options.maxBytes) {
      break;
    }
  }

  const done = windowEnd >= source.size && cursor >= bytes.length;

  if (rows.length === 0 && !done) {
    throw new ChunkReadError(
      "No data rows were found in this 8 MB part of the file. Remove the blank region or split the file.",
    );
  }

  return {
    startOffset,
    endOffset: done ? source.size : lastEnd,
    nextRow: rowIndex,
    rows,
    done,
  };
}

/** Reads one chunk from a CSV byte source. */
export async function readCsvChunk(
  source: ByteSource,
  layout: CsvLayout,
  startOffset: number,
  nextRow: number,
  options: ReadChunkOptions,
): Promise<RawChunk> {
  if (startOffset >= source.size) {
    return emptyChunk(startOffset, nextRow, source.size);
  }

  const windowEnd = Math.min(source.size, startOffset + SCAN_WINDOW_BYTES);
  const bytes = await source.read(startOffset, windowEnd);
  if (bytes.length === 0) {
    return emptyChunk(startOffset, nextRow, source.size);
  }

  let cursor = 0;

  if (startOffset === 0) {
    let header;
    try {
      header = findCsvRecord(bytes, 0);
    } catch (caught) {
      throw new ChunkReadError(
        caught instanceof CsvError
          ? caught.message
          : "The CSV header could not be read.",
      );
    }

    if (header.next === bytes.length && windowEnd < source.size) {
      throw new ChunkReadError(
        "The CSV header is longer than 8 MB. Use a smaller header row.",
      );
    }

    cursor = header.next;
  }

  const rows: RawRow[] = [];
  let lastEnd = startOffset + cursor;
  let rowIndex = nextRow;
  let rawBytes = 0;

  while (cursor < bytes.length) {
    let range;
    try {
      range = findCsvRecord(bytes, cursor);
    } catch (caught) {
      throw new ChunkReadError(
        caught instanceof CsvError
          ? caught.message
          : "The CSV record could not be read.",
      );
    }

    const endsWindow = range.next === bytes.length;
    const hasNewline =
      range.contentEnd < bytes.length && bytes[range.contentEnd] === 0x0a;

    if (endsWindow && !hasNewline && windowEnd < source.size) {
      if (rows.length === 0) {
        throw new ChunkReadError(
          "A CSV record in this part of the file is longer than 8 MB. Split the file before importing it.",
        );
      }
      break;
    }

    let contentEnd = range.contentEnd;
    if (contentEnd > range.contentStart && bytes[contentEnd - 1] === 0x0d) {
      contentEnd -= 1;
    }

    if (!isBlank(bytes, range.contentStart, contentEnd)) {
      const byteLength = contentEnd - range.contentStart;

      if (rows.length === 0 && byteLength > options.maxBytes) {
        throw new RowTooLargeError(rowIndex + 1, byteLength);
      }

      if (
        rows.length > 0 &&
        (rows.length >= options.chunkRows ||
          rawBytes + byteLength > options.maxBytes)
      ) {
        break;
      }

      const record = decode(bytes.subarray(range.contentStart, contentEnd));
      let raw: string;
      try {
        raw = csvRecordToRaw(record, layout);
      } catch (caught) {
        throw new ChunkReadError(
          caught instanceof CsvError
            ? caught.message
            : "The CSV record could not be read.",
        );
      }

      rows.push({
        raw,
        rowIndex: rowIndex + 1,
        byteLength,
      });
      rawBytes += byteLength;
      rowIndex += 1;
    }

    cursor = range.next;
    lastEnd = startOffset + cursor;

    if (rows.length >= options.chunkRows || rawBytes >= options.maxBytes) {
      break;
    }
  }

  const done = windowEnd >= source.size && cursor >= bytes.length;

  if (rows.length === 0 && !done) {
    throw new ChunkReadError(
      "No data rows were found in this 8 MB part of the file. Remove the blank region or split the file.",
    );
  }

  return {
    startOffset,
    endOffset: done ? source.size : lastEnd,
    nextRow: rowIndex,
    rows,
    done,
  };
}

/** Dispatches to the reader for the prepared source format. */
export async function readChunk(
  source: ByteSource,
  format: UploadFormat,
  layout: CsvLayout | null,
  startOffset: number,
  nextRow: number,
  options: ReadChunkOptions,
): Promise<RawChunk> {
  if (format === "csv") {
    if (!layout) {
      throw new ChunkReadError("The CSV columns were not read.");
    }
    return readCsvChunk(source, layout, startOffset, nextRow, options);
  }

  return readJsonlChunk(source, startOffset, nextRow, options);
}
