import {
  countCharacters,
  khowarLetterStats,
  normalizeKhowar,
} from "../khowar";
import type { LineBox } from "./segment-core";

/**
 * Label rules for one OCR line. Lines can contain numbers and punctuation,
 * so unlike the other modules the Arabic-script ratio is not required here.
 * Only the Latin-letter guard, the length and the empty check apply.
 */

export const MAX_LINE_LABEL = 400;

export type LineStatus = "empty" | "labeled" | "unreadable";

export type LineDraft = {
  id: string;
  box: LineBox;
  label: string;
  status: LineStatus;
};

export type LabelValidation =
  | { ok: true; value: string }
  | { ok: false; value: string; error: string };

/** NFC, controls removed, newlines turned into spaces, spaces collapsed. */
export function normalizeLabel(value: string): string {
  return normalizeKhowar(
    value
      .replace(/\r\n?/g, "\n")
      .replace(/[\n\u2028\u2029]+/g, " "),
  );
}

/** The status a line gets from its text when it is not marked unreadable. */
export function statusForLabel(label: string): "empty" | "labeled" {
  return normalizeLabel(label) === "" ? "empty" : "labeled";
}

/** Validation for one line, used by the save action and by tests. */
export function validateLabel(text: string): LabelValidation {
  const value = normalizeLabel(text);

  if (value === "") {
    return {
      ok: false,
      value,
      error: "Write the line, or mark it as unreadable.",
    };
  }

  if (countCharacters(value) > MAX_LINE_LABEL) {
    return {
      ok: false,
      value,
      error: "This line is too long. Keep it under 400 characters.",
    };
  }

  const stats = khowarLetterStats(value);
  if (stats.letters > 0 && stats.latin / stats.letters > 0.2) {
    return {
      ok: false,
      value,
      error:
        "Too many Latin letters. Keep Latin letters under 20 percent of the line.",
    };
  }

  return { ok: true, value };
}

export type LineProgress = {
  labeled: number;
  unreadable: number;
  empty: number;
  total: number;
};

export function lineProgress(lines: readonly LineDraft[]): LineProgress {
  const progress: LineProgress = {
    labeled: 0,
    unreadable: 0,
    empty: 0,
    total: lines.length,
  };

  for (const line of lines) {
    if (line.status === "labeled") progress.labeled += 1;
    else if (line.status === "unreadable") progress.unreadable += 1;
    else progress.empty += 1;
  }

  return progress;
}

export function previousLineIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  const current = Math.min(total - 1, Math.max(0, Math.trunc(index)));
  return Math.max(0, current - 1);
}

export function nextLineIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  const current = Math.min(total - 1, Math.max(0, Math.trunc(index)));
  return Math.min(total - 1, current + 1);
}

/**
 * The next empty line after `from`, wrapping once at the end. Pass -1 to
 * start at the first line. Returns null when every line is done.
 */
export function nextEmptyLineIndex(
  lines: readonly LineDraft[],
  from: number,
): number | null {
  const total = lines.length;
  if (total === 0) return null;

  const start =
    total === 0
      ? 0
      : Math.min(total - 1, Math.max(-1, Math.trunc(from)));

  for (let step = 1; step <= total; step++) {
    const index = (start + step + total) % total;
    if (lines[index]?.status === "empty") return index;
  }

  return null;
}
