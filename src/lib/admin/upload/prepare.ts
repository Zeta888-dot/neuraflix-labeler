/**
 * Turns a selected File into a byte source the chunk reader can use.
 *
 * .jsonl and .csv are read directly from the File. A .json array is parsed in
 * memory (limited to 20 MB) and re-serialised as JSON Lines, because a JSON
 * array has no reliable byte row boundary before parsing. The file hash still
 * covers the original bytes.
 */

import {
  CsvError,
  parseCsvHeader,
  parseCsvRecord,
  type CsvLayout,
} from "./csv";
import { findCsvRecord } from "./csv";
import type { ByteSource, HashSource } from "./hash";
import type { UploadFormat } from "./types";

const JSON_ARRAY_MAX_BYTES = 20 * 1024 * 1024;
const HEADER_MAX_BYTES = 1024 * 1024;

export class PrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrepareError";
  }
}

export type PreparedSource = {
  format: UploadFormat;
  originalName: string;
  originalSize: number;
  source: ByteSource;
  hashSource: HashSource;
  csvLayout: CsvLayout | null;
  note: string | null;
};

export function memoryByteSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read(start: number, end: number): Promise<Uint8Array> {
      return Promise.resolve(bytes.slice(start, end));
    },
  };
}

export function fileByteSource(file: File): ByteSource {
  return {
    size: file.size,
    async read(start: number, end: number): Promise<Uint8Array> {
      return new Uint8Array(await file.slice(start, end).arrayBuffer());
    },
  };
}

/** Adds the file name the chained hash needs. */
export function namedHashSource(
  name: string,
  source: ByteSource,
): HashSource {
  return {
    name,
    size: source.size,
    read: source.read.bind(source),
  };
}

function jsonRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.rows)) return record.rows;
    if (
      typeof record.instruction === "string" ||
      typeof record.response === "string" ||
      typeof record.output === "string"
    ) {
      return [record];
    }
  }

  throw new PrepareError(
    "A .json file must be an array of objects, an object with a data or rows array, or one instruction object.",
  );
}

/** Converts a parsed JSON value to deterministic JSON Lines. */
export function normalizeJsonArrayValue(value: unknown): string {
  const rows = jsonRows(value);
  return rows
    .map((row) => `${JSON.stringify(row) ?? "null"}\n`)
    .join("");
}

/** Parses JSON text and returns JSON Lines. Throws on invalid JSON. */
export function normalizeJsonArrayText(text: string): string {
  const clean = text.replace(/^\uFEFF/, "");
  return normalizeJsonArrayValue(JSON.parse(clean) as unknown);
}

/** Reads the first CSV record and returns its fields. */
export async function readCsvHeader(
  source: ByteSource,
): Promise<string[]> {
  const end = Math.min(source.size, HEADER_MAX_BYTES);
  const bytes = await source.read(0, end);

  let range;
  try {
    range = findCsvRecord(bytes, 0);
  } catch (caught) {
    throw new PrepareError(
      caught instanceof CsvError
        ? caught.message
        : "The CSV header could not be read.",
    );
  }

  const hasNewline =
    range.contentEnd < bytes.length && bytes[range.contentEnd] === 0x0a;

  if (!hasNewline && source.size > HEADER_MAX_BYTES) {
    throw new PrepareError(
      "The CSV header is longer than 1 MB. Use a shorter header row.",
    );
  }

  let contentEnd = range.contentEnd;
  if (contentEnd > 0 && bytes[contentEnd - 1] === 0x0d) {
    contentEnd -= 1;
  }

  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, contentEnd));
  const fields = parseCsvRecord(text);
  if (fields.length === 1 && fields[0].trim() === "") {
    throw new PrepareError("The CSV file has no header row.");
  }

  return fields;
}

/** Prepares a file for hashing and chunked reading. */
export async function prepareFile(file: File): Promise<PreparedSource> {
  const extension = file.name.split(".").pop()?.toLowerCase();

  if (extension === "jsonl") {
    const source = fileByteSource(file);
    return {
      format: "jsonl",
      originalName: file.name,
      originalSize: file.size,
      source,
      hashSource: namedHashSource(file.name, source),
      csvLayout: null,
      note: null,
    };
  }

  if (extension === "csv") {
    const source = fileByteSource(file);
    const header = await readCsvHeader(source);
    let csvLayout: CsvLayout;
    try {
      csvLayout = parseCsvHeader(header);
    } catch (caught) {
      throw new PrepareError(
        caught instanceof CsvError
          ? caught.message
          : "The CSV columns could not be read.",
      );
    }

    return {
      format: "csv",
      originalName: file.name,
      originalSize: file.size,
      source,
      hashSource: namedHashSource(file.name, source),
      csvLayout,
      note: null,
    };
  }

  if (extension === "json") {
    if (file.size > JSON_ARRAY_MAX_BYTES) {
      throw new PrepareError(
        "JSON array files are limited to 20 MB in the browser. Convert this file to .jsonl for a larger import.",
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("utf-8").decode(bytes);

    let normalized: string | null = null;
    try {
      normalized = normalizeJsonArrayText(text);
    } catch (caught) {
      if (caught instanceof PrepareError) throw caught;
      // Not valid JSON as a whole. Treat the file as JSON Lines, which also
      // supports a .json file that contains one object per line.
    }

    if (normalized !== null) {
      return {
        format: "json",
        originalName: file.name,
        originalSize: file.size,
        source: memoryByteSource(new TextEncoder().encode(normalized)),
        hashSource: namedHashSource(file.name, memoryByteSource(bytes)),
        csvLayout: null,
        note: "JSON converted to one row per line in memory.",
      };
    }

    return {
      format: "jsonl",
      originalName: file.name,
      originalSize: file.size,
      source: memoryByteSource(bytes),
      hashSource: namedHashSource(file.name, memoryByteSource(bytes)),
      csvLayout: null,
      note: "The file is not one JSON value, so it is read as JSON Lines.",
    };
  }

  throw new PrepareError("Choose a .json, .jsonl, or .csv file.");
}
