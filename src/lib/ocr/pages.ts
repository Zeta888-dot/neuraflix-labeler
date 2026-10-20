/**
 * Shared OCR page shapes for My pages, the dashboard and the admin page. Free
 * of Supabase and Node imports so client components can import the labels.
 */

export const OCR_PAGE_SIZE = 20;

export const OCR_PAGE_STATUSES = [
  "uploading",
  "submitted",
  "approved",
  "rejected",
  "failed",
] as const;

export type OcrPageStatus = (typeof OCR_PAGE_STATUSES)[number];

export const ocrStatusLabels: Record<OcrPageStatus, string> = {
  uploading: "Incomplete",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  failed: "Failed",
};

export const ocrStatusTones: Record<
  OcrPageStatus,
  "neutral" | "accent" | "error"
> = {
  uploading: "neutral",
  submitted: "accent",
  approved: "accent",
  rejected: "error",
  failed: "error",
};

export function isOcrPageStatus(value: unknown): value is OcrPageStatus {
  return (
    typeof value === "string" &&
    (OCR_PAGE_STATUSES as readonly string[]).includes(value)
  );
}

export const OCR_LINE_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
] as const;

export type OcrLineStatus = (typeof OCR_LINE_STATUSES)[number];

export const ocrLineStatusLabels: Record<OcrLineStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

export type OcrPageSummary = {
  id: string;
  label: string | null;
  status: OcrPageStatus;
  lineCount: number;
  reviewNote: string | null;
  createdAt: string;
  /** Formatted on the server so server and client markup match. */
  createdLabel: string;
};

export type OcrPagesPage = {
  items: OcrPageSummary[];
  nextOffset: number | null;
};

export type OcrPageStatusCounts = Record<OcrPageStatus, number>;

export const emptyOcrPageCounts: OcrPageStatusCounts = {
  uploading: 0,
  submitted: 0,
  approved: 0,
  rejected: 0,
  failed: 0,
};

export type OcrCounts = {
  pages: OcrPageStatusCounts;
  lines: number;
};

export type OcrAdminStats = {
  pages: OcrPageStatusCounts;
  lines: Record<OcrLineStatus, number>;
};

export type OcrStorageStatus = {
  usedBytes: number;
  quotaBytes: number;
};
