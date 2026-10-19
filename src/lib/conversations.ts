import {
  isConversationRole,
  type ConversationFieldErrors,
  type ConversationSource,
  type ConversationTurn,
} from "@/lib/khowar";

/**
 * Shared shapes for the conversations module. Pure data: imported by the client
 * workspace, by the server actions and by the server pages.
 */

export type ConversationItem = {
  id: string;
  english: ConversationSource;
  source: string | null;
  targetCount: number;
  claimedUntil: string | null;
};

export type ConversationCounts = {
  draft: number;
  submitted: number;
  approved: number;
  rejected: number;
};

export const emptyConversationCounts: ConversationCounts = {
  draft: 0,
  submitted: 0,
  approved: 0,
  rejected: 0,
};

export type ClaimResult =
  | { status: "claimed"; item: ConversationItem }
  | { status: "empty" }
  | { status: "error"; message: string };

/** Everything an action hands back after touching the claim queue. */
export type WorkspaceData = {
  claim: ClaimResult;
  counts: ConversationCounts | null;
  /** Submitted plus approved conversations by this contributor, or null. */
  submitted: number | null;
};

export type SubmitInput = {
  itemId: string;
  /**
   * Echoed from the claim payload so the server can compare against it. It is
   * only read for validation, never written. Turn content is admin owned.
   */
  english: ConversationTurn[];
  /** The Khowar turns in the English order, roles echoed from the item. */
  turns: ConversationTurn[];
  acknowledgeWarnings: boolean;
};

export type SubmitResult =
  | { status: "submitted"; workspace: WorkspaceData }
  | { status: "warnings"; warnings: string[] }
  | { status: "invalid"; errors: ConversationFieldErrors }
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

/**
 * Reads the jsonb turns payload of an item (`{turns:[{role,content}]}`).
 * Returns null when a turn is unusable, so a broken item is never shown.
 */
export function parseConversationSource(
  value: unknown,
): ConversationSource | null {
  if (!value || typeof value !== "object") return null;

  const raw = (value as Record<string, unknown>).turns;
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const turns: ConversationTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const turn = entry as Record<string, unknown>;

    if (!isConversationRole(turn.role)) return null;
    const content = trimmedString(turn.content);
    if (!content) return null;

    turns.push({ role: turn.role, content });
  }

  return { turns };
}

/**
 * Reads one claim_next row (snake_case json from PostgREST). The function's
 * output columns carry the out_ prefix since 0003, so they cannot shadow a
 * table column.
 */
export function parseConversationRow(value: unknown): ConversationItem | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const id = trimmedString(row.out_item_id);
  const english = parseConversationSource(row.out_english);
  if (!id || !english) return null;

  const target =
    typeof row.out_target_count === "number" && row.out_target_count >= 1
      ? row.out_target_count
      : 1;

  return {
    id,
    english,
    source: trimmedString(row.out_source),
    targetCount: target,
    claimedUntil: trimmedString(row.out_claimed_until),
  };
}

/** Roles as they are shown next to a turn. */
export const roleLabels: Record<ConversationTurn["role"], string> = {
  system: "System",
  user: "User",
  assistant: "Assistant",
};
