/**
 * Instruction row validation for the browser import. The database validates
 * every row again with the same rules, so a changed client cannot skip them.
 */

import { englishHashSource } from "../../khowar";
import { sha256Hex } from "./hash";
import type { ImportErrorRow, ParsedRow, RawRow } from "./types";

export type RowValidation =
  | {
      ok: true;
      row: {
        instruction: string;
        response: string;
        input: string | null;
        source: string | null;
      };
      hashSource: string;
    }
  | { ok: false; reason: string; detail: string | null };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

/** Validates one parsed instruction object. */
export function validateInstructionRow(
  value: unknown,
  fileSource: string | null,
): RowValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not_an_object", detail: null };
  }

  const record = value as Record<string, unknown>;
  if (typeof record.instruction !== "string") {
    return { ok: false, reason: "missing_instruction", detail: null };
  }

  const instruction = text(record.instruction);
  if (!instruction) {
    return { ok: false, reason: "empty_instruction", detail: null };
  }
  if (instruction.length > 20_000) {
    return { ok: false, reason: "instruction_too_long", detail: null };
  }

  // The database only falls back to output when response is not a string.
  // An empty or whitespace-only response string is rejected as missing.
  const response =
    typeof record.response === "string"
      ? text(record.response)
      : text(record.output);
  if (!response) {
    return { ok: false, reason: "missing_response", detail: null };
  }
  if (response.length > 20_000) {
    return { ok: false, reason: "response_too_long", detail: null };
  }

  if (
    record.input !== undefined &&
    record.input !== null &&
    typeof record.input !== "string"
  ) {
    return { ok: false, reason: "invalid_input", detail: null };
  }

  const input = text(record.input);
  if (input && input.length > 20_000) {
    return { ok: false, reason: "input_too_long", detail: null };
  }

  if (
    record.source !== undefined &&
    record.source !== null &&
    typeof record.source !== "string"
  ) {
    return { ok: false, reason: "invalid_source", detail: null };
  }

  const rowSource = text(record.source);
  if (rowSource && rowSource.length > 120) {
    return { ok: false, reason: "source_too_long", detail: null };
  }

  const source = rowSource ?? fileSource;

  return {
    ok: true,
    row: { instruction, response, input, source },
    hashSource: englishHashSource(instruction, input),
  };
}

/** Parses one JSONL or converted CSV row and validates it. */
export function parseInstructionRaw(
  raw: string,
  fileSource: string | null,
): RowValidation {
  if (raw.trim() === "") {
    return { ok: false, reason: "empty_row", detail: null };
  }

  if (new TextEncoder().encode(raw).length > 524_288) {
    return { ok: false, reason: "row_too_large", detail: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "invalid_json",
      detail: raw.slice(0, 300),
    };
  }

  return validateInstructionRow(parsed, fileSource);
}

/** Counts hashes that repeat inside one chunk. */
export function countDuplicateHashes(hashes: readonly string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;

  for (const hash of hashes) {
    if (seen.has(hash)) {
      duplicates += 1;
    } else {
      seen.add(hash);
    }
  }

  return duplicates;
}

export type PreviewRows = {
  rows: ParsedRow[];
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  errors: ImportErrorRow[];
};

/**
 * Validates a raw chunk, hashes every valid row and marks hashes that repeat
 * inside the chunk. Database duplicates are counted later by the RPC.
 */
export async function buildPreviewRows(
  rows: readonly RawRow[],
  fileSource: string | null,
): Promise<PreviewRows> {
  const parsed: ParsedRow[] = [];
  const seen = new Set<string>();
  const errors: ImportErrorRow[] = [];
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    const result = parseInstructionRaw(row.raw, fileSource);

    if (!result.ok) {
      invalidCount += 1;
      parsed.push({
        ...row,
        valid: false,
        reason: result.reason,
        detail: result.detail,
        hash: null,
      });
      if (errors.length < 5) {
        errors.push({
          rowIndex: row.rowIndex,
          reason: result.reason,
          detail: result.detail,
        });
      }
      continue;
    }

    const hash = await sha256Hex(result.hashSource);
    const duplicate = seen.has(hash);
    if (duplicate) {
      duplicateCount += 1;
    } else {
      seen.add(hash);
      validCount += 1;
    }

    parsed.push({
      ...row,
      valid: true,
      reason: duplicate ? "duplicate_hash" : null,
      detail: null,
      hash,
    });
  }

  return { rows: parsed, validCount, invalidCount, duplicateCount, errors };
}
