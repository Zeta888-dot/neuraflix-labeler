import { z } from "zod";

/**
 * Pure admin shapes and parsers. The overview and user list come from two
 * database functions, so every row is checked before it reaches the page.
 */

export const ADMIN_ROLES = ["contributor", "reviewer", "admin"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const adminRoleLabels: Record<AdminRole, string> = {
  contributor: "Contributor",
  reviewer: "Reviewer",
  admin: "Admin",
};

export function isAdminRole(value: unknown): value is AdminRole {
  return (
    typeof value === "string" && (ADMIN_ROLES as readonly string[]).includes(value)
  );
}

export const adminRoleSchema = z.enum(ADMIN_ROLES);

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function adminDateLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
}

export type StatusCounts = Record<string, number>;

export type AdminOverview = {
  instruction: StatusCounts;
  conversation: StatusCounts;
  text: StatusCounts;
  ocrPages: StatusCounts;
  ocrLines: StatusCounts;
  users: StatusCounts;
  recentContributors: number;
};

export type AdminUser = {
  userId: string;
  email: string;
  displayName: string | null;
  role: AdminRole;
  consentAt: string | null;
  consentLabel: string;
  createdAt: string;
  createdLabel: string;
  instructionCount: number;
  conversationCount: number;
  textCount: number;
  ocrPageCount: number;
  totalCount: number;
};

/** The two read-only settings shown on the admin page, as stored text. */
export type AdminSettings = {
  allowSelfReview: string;
  ocrQuotaMb: string;
};

function numberOf(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.trunc(number);
}

function parseStatusCounts(
  value: unknown,
  keys: readonly string[],
): StatusCounts | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const counts: StatusCounts = {};

  for (const key of keys) {
    const count = numberOf(record[key]);
    if (count === null) return null;
    counts[key] = count;
  }

  return counts;
}

const INSTRUCTION_KEYS = ["draft", "submitted", "approved", "rejected"] as const;
const CONVERSATION_KEYS = INSTRUCTION_KEYS;
const TEXT_KEYS = ["submitted", "approved", "rejected"] as const;
const OCR_PAGE_KEYS = [
  "uploading",
  "submitted",
  "approved",
  "rejected",
  "failed",
] as const;
const OCR_LINE_KEYS = ["submitted", "approved", "rejected"] as const;
const USER_KEYS = ["contributor", "reviewer", "admin", "total"] as const;

/** Reads one admin_overview row. Returns null when any block is unusable. */
export function parseAdminOverview(value: unknown): AdminOverview | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  let items: Record<string, unknown>;
  try {
    items =
      typeof row.out_items === "string"
        ? (JSON.parse(row.out_items) as Record<string, unknown>)
        : (row.out_items as Record<string, unknown>);
  } catch {
    return null;
  }

  let users: Record<string, unknown>;
  try {
    users =
      typeof row.out_users === "string"
        ? (JSON.parse(row.out_users) as Record<string, unknown>)
        : (row.out_users as Record<string, unknown>);
  } catch {
    return null;
  }

  if (!items || typeof items !== "object" || !users || typeof users !== "object") {
    return null;
  }

  const instruction = parseStatusCounts(items.instruction, INSTRUCTION_KEYS);
  const conversation = parseStatusCounts(items.conversation, CONVERSATION_KEYS);
  const text = parseStatusCounts(items.text, TEXT_KEYS);
  const ocrPages = parseStatusCounts(items.ocr_pages, OCR_PAGE_KEYS);
  const ocrLines = parseStatusCounts(items.ocr_lines, OCR_LINE_KEYS);
  const userCounts = parseStatusCounts(users, USER_KEYS);
  const recentContributors = numberOf(row.out_recent_contributors);

  if (
    !instruction ||
    !conversation ||
    !text ||
    !ocrPages ||
    !ocrLines ||
    !userCounts ||
    recentContributors === null
  ) {
    return null;
  }

  return {
    instruction,
    conversation,
    text,
    ocrPages,
    ocrLines,
    users: userCounts,
    recentContributors,
  };
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Reads one admin_list_users row. */
export function parseAdminUser(value: unknown): AdminUser | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const userId = trimmedString(row.out_user_id);
  const email = trimmedString(row.out_email);
  if (!userId || !email || !isAdminRole(row.out_role)) return null;

  const createdAt = trimmedString(row.out_created_at);
  if (!createdAt) return null;

  const instructionCount = numberOf(row.out_instruction_count);
  const conversationCount = numberOf(row.out_conversation_count);
  const textCount = numberOf(row.out_text_count);
  const ocrPageCount = numberOf(row.out_ocr_page_count);

  if (
    instructionCount === null ||
    conversationCount === null ||
    textCount === null ||
    ocrPageCount === null
  ) {
    return null;
  }

  const consentAt = trimmedString(row.out_consent_at);

  return {
    userId,
    email,
    displayName: trimmedString(row.out_display_name),
    role: row.out_role,
    consentAt,
    consentLabel: adminDateLabel(consentAt),
    createdAt,
    createdLabel: adminDateLabel(createdAt),
    instructionCount,
    conversationCount,
    textCount,
    ocrPageCount,
    totalCount:
      instructionCount + conversationCount + textCount + ocrPageCount,
  };
}

/** Reads the single admin_settings_status row. */
export function parseAdminSettings(value: unknown): AdminSettings | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const allowSelfReview = trimmedString(row.allow_self_review);
  const ocrQuotaMb = trimmedString(row.ocr_quota_mb);

  if (!allowSelfReview || !ocrQuotaMb) return null;

  return { allowSelfReview, ocrQuotaMb };
}
