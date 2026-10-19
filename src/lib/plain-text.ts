import type { PlainTextFieldErrors } from "@/lib/khowar";

/**
 * Shared shapes for the plain text module. This file is imported by the client
 * workspace, the server actions and the server page, so it stays free of
 * Supabase and Node imports.
 */

export const PLAIN_TEXT_PAGE_SIZE = 20;
export const PLAIN_TEXT_PREVIEW_CHARS = 60;

export const TEXT_SUBMISSION_STATUSES = [
  "submitted",
  "approved",
  "rejected",
] as const;

export type TextSubmissionStatus = (typeof TEXT_SUBMISSION_STATUSES)[number];

export function isTextSubmissionStatus(
  value: unknown,
): value is TextSubmissionStatus {
  return (
    typeof value === "string" &&
    (TEXT_SUBMISSION_STATUSES as readonly string[]).includes(value)
  );
}

export const plainTextStatusLabels: Record<TextSubmissionStatus, string> = {
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

export type PlainTextSubmission = {
  id: string;
  title: string | null;
  /** First 60 characters of the text, whitespace collapsed. */
  preview: string;
  characters: number;
  status: TextSubmissionStatus;
  reviewNote: string | null;
  createdAt: string;
  /** Formatted on the server so server and client markup always match. */
  createdLabel: string;
};

export type PlainTextCounts = Record<TextSubmissionStatus, number>;

export const emptyPlainTextCounts: PlainTextCounts = {
  submitted: 0,
  approved: 0,
  rejected: 0,
};

export type PlainTextPage = {
  items: PlainTextSubmission[];
  nextOffset: number | null;
};

export type PlainTextSubmitInput = {
  title: string;
  khowar_text: string;
  source_note: string;
  rights_confirmed: boolean;
};

export type PlainTextSubmitResult =
  | { status: "submitted"; item: PlainTextSubmission }
  | { status: "duplicate"; message: string }
  | { status: "invalid"; errors: PlainTextFieldErrors }
  | { status: "error"; message: string };

export type PlainTextPageResult =
  | { status: "loaded"; page: PlainTextPage }
  | { status: "error"; message: string };
