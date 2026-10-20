import {
  OCR_LINE_STATUSES,
  OCR_PAGE_SIZE,
  OCR_PAGE_STATUSES,
  emptyOcrPageCounts,
  isOcrPageStatus,
  type OcrAdminStats,
  type OcrCounts,
  type OcrLineStatus,
  type OcrPageStatusCounts,
  type OcrPageSummary,
  type OcrPagesPage,
  type OcrStorageStatus,
} from "@/lib/ocr/pages";
import { logOcrSubmitError } from "@/lib/ocr/log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server only reads for OCR. Every query runs with the caller's session, so RLS
 * narrows contributors to their own pages. Staff read policies let the admin
 * counts see every row; the admin page checks the role before calling them.
 */

const ADMIN_CHUNK_SIZE = 1000;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
}

export function parseOcrPageRow(value: unknown): OcrPageSummary | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const id = typeof row.id === "string" ? row.id : null;
  const createdAt = typeof row.created_at === "string" ? row.created_at : null;
  const lineCount =
    typeof row.line_count === "number" ? row.line_count : Number(row.line_count);

  if (
    !id ||
    !createdAt ||
    !isOcrPageStatus(row.status) ||
    !Number.isFinite(lineCount)
  ) {
    return null;
  }

  const label =
    typeof row.label === "string" && row.label.trim() !== "" ? row.label : null;
  const reviewNote =
    row.status === "rejected" &&
    typeof row.review_note === "string" &&
    row.review_note.trim() !== ""
      ? row.review_note
      : null;

  return {
    id,
    label,
    status: row.status,
    lineCount: Math.max(0, Math.trunc(lineCount)),
    reviewNote,
    createdAt,
    createdLabel: dateLabel(createdAt),
  };
}

/** The signed-in contributor's pages, newest first, 20 per page. */
export async function getOcrPagesPage(
  userId: string,
  offset = 0,
): Promise<OcrPagesPage | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("ocr_pages")
    .select("id, label, line_count, status, review_note, created_at")
    .eq("contributor_id", userId)
    .in("status", [...OCR_PAGE_STATUSES])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + OCR_PAGE_SIZE);

  if (error) {
    logOcrSubmitError(error);
    return null;
  }

  const rows: unknown[] = Array.isArray(data) ? data : [];
  const hasMore = rows.length > OCR_PAGE_SIZE;
  const items = rows
    .slice(0, OCR_PAGE_SIZE)
    .map(parseOcrPageRow)
    .filter((item): item is OcrPageSummary => item !== null);

  return {
    items,
    nextOffset: hasMore ? offset + OCR_PAGE_SIZE : null,
  };
}

/** The contributor's page counts by status and their uploaded line total. */
export async function getOcrCounts(
  userId: string,
): Promise<OcrCounts | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    OCR_PAGE_STATUSES.map((status) =>
      supabase
        .from("ocr_pages")
        .select("id", { count: "exact", head: true })
        .eq("contributor_id", userId)
        .eq("status", status),
    ),
  );

  const pages: OcrPageStatusCounts = { ...emptyOcrPageCounts };

  for (let index = 0; index < OCR_PAGE_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") {
      if (result.error) logOcrSubmitError(result.error);
      return null;
    }
    pages[OCR_PAGE_STATUSES[index]] = result.count;
  }

  let lines = 0;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("ocr_pages")
      .select("id, line_count")
      .eq("contributor_id", userId)
      .in("status", ["submitted", "approved", "rejected"])
      .order("id", { ascending: true })
      .range(from, from + ADMIN_CHUNK_SIZE - 1);

    if (error) {
      logOcrSubmitError(error);
      return null;
    }

    const rows: unknown[] = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const value = (row as Record<string, unknown>).line_count;
      const count = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(count)) lines += Math.max(0, Math.trunc(count));
    }

    if (rows.length < ADMIN_CHUNK_SIZE) break;
    from += ADMIN_CHUNK_SIZE;
  }

  return { pages, lines };
}

/** Every page and line, counted by status. Admin only, checked by the page. */
export async function getOcrAdminStats(): Promise<OcrAdminStats | null> {
  const supabase = await createClient();

  const [pageResults, lineResults] = await Promise.all([
    Promise.all(
      OCR_PAGE_STATUSES.map((status) =>
        supabase
          .from("ocr_pages")
          .select("id", { count: "exact", head: true })
          .eq("status", status),
      ),
    ),
    Promise.all(
      OCR_LINE_STATUSES.map((status) =>
        supabase
          .from("ocr_lines")
          .select("id", { count: "exact", head: true })
          .eq("status", status),
      ),
    ),
  ]);

  const pages: OcrPageStatusCounts = { ...emptyOcrPageCounts };

  for (let index = 0; index < OCR_PAGE_STATUSES.length; index += 1) {
    const result = pageResults[index];
    if (result.error || typeof result.count !== "number") {
      if (result.error) logOcrSubmitError(result.error);
      return null;
    }
    pages[OCR_PAGE_STATUSES[index]] = result.count;
  }

  const lines = Object.fromEntries(
    OCR_LINE_STATUSES.map((status) => [status, 0]),
  ) as Record<OcrLineStatus, number>;

  for (let index = 0; index < OCR_LINE_STATUSES.length; index += 1) {
    const result = lineResults[index];
    if (result.error || typeof result.count !== "number") {
      if (result.error) logOcrSubmitError(result.error);
      return null;
    }
    lines[OCR_LINE_STATUSES[index]] = result.count;
  }

  return { pages, lines };
}

/** Used and quota bytes from the database function. */
export async function getOcrStorageStatus(): Promise<OcrStorageStatus | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ocr_storage_status");

  if (error) {
    logOcrSubmitError(error);
    return null;
  }

  const rows: unknown[] = Array.isArray(data) ? data : [];
  const row = rows[0];
  if (!row || typeof row !== "object") return null;

  const record = row as Record<string, unknown>;
  const usedBytes = Number(record.used_bytes);
  const quotaBytes = Number(record.quota_bytes);

  if (!Number.isFinite(usedBytes) || !Number.isFinite(quotaBytes)) return null;

  return {
    usedBytes: Math.max(0, usedBytes),
    quotaBytes: Math.max(0, quotaBytes),
  };
}
