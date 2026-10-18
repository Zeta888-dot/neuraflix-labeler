import type {
  EnglishSource,
  InstructionTranslationValues,
  KhowarFieldErrors,
} from "@/lib/khowar";

/**
 * Shared shapes for the instructions module. Pure data: imported by the
 * client workspace, by the server actions and by the server pages.
 */

export type InstructionItem = {
  id: string;
  english: EnglishSource;
  source: string | null;
  targetCount: number;
  claimedUntil: string | null;
};

export type InstructionCounts = {
  draft: number;
  submitted: number;
  approved: number;
  rejected: number;
};

export const emptyInstructionCounts: InstructionCounts = {
  draft: 0,
  submitted: 0,
  approved: 0,
  rejected: 0,
};

export type ClaimResult =
  | { status: "claimed"; item: InstructionItem }
  | { status: "empty" }
  | { status: "error"; message: string };

/** Everything an action hands back after touching the claim queue. */
export type WorkspaceData = {
  claim: ClaimResult;
  counts: InstructionCounts | null;
  /** Submitted plus approved translations by this contributor, or null. */
  submitted: number | null;
};

export type SubmitInput = {
  itemId: string;
  /**
   * Echoed from the claim payload so the server can compare against it. It is
   * only read for validation, never written. Item content is admin owned.
   */
  english: EnglishSource;
  values: InstructionTranslationValues;
  acknowledgeWarnings: boolean;
};

export type SubmitResult =
  | { status: "submitted"; workspace: WorkspaceData }
  | { status: "warnings"; warnings: string[] }
  | { status: "invalid"; errors: KhowarFieldErrors }
  | { status: "expired"; workspace: WorkspaceData }
  | { status: "error"; message: string };

export type SkipResult =
  | { status: "skipped"; workspace: WorkspaceData }
  | { status: "error"; message: string };

export type ReportInput = { itemId: string; note: string };

export type ReportResult =
  | { status: "reported"; workspace: WorkspaceData }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Reads the jsonb English payload. Returns null when it is unusable. */
export function parseEnglishSource(value: unknown): EnglishSource | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  const instruction = trimmedString(record.instruction);
  const response = trimmedString(record.response);
  if (!instruction || !response) return null;

  return { instruction, input: trimmedString(record.input), response };
}

/** Reads one claim_next row (snake_case json from PostgREST). */
export function parseInstructionRow(value: unknown): InstructionItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const id = trimmedString(row.item_id);
  const english = parseEnglishSource(row.english);
  if (!id || !english) return null;

  const target =
    typeof row.target_count === "number" && row.target_count >= 1
      ? row.target_count
      : 1;

  return {
    id,
    english,
    source: trimmedString(row.source),
    targetCount: target,
    claimedUntil: trimmedString(row.claimed_until),
  };
}
