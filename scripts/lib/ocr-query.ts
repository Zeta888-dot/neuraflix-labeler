import type { SupabaseClient } from "@supabase/supabase-js";
import type { OcrExportRecord } from "./export-core";
import { isUuid } from "./ocr-paths";

/**
 * Reads approved OCR lines together with their approved pages. The live
 * queries also filter in SQL; the parser repeats the checks so a malformed row
 * can never reach a file or a storage deletion.
 */

const PAGE_SIZE = 1000;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function positiveNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.trunc(number);
}

function joinedObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function parseRow(value: unknown): OcrExportRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const page = joinedObject(row.ocr_pages);

  const id = optionalString(row.id);
  const pageId = optionalString(row.page_id);
  const status = optionalString(row.status);
  const pageStatus = optionalString(page?.status);
  if (!id || !pageId || !status || !pageStatus) return null;

  const label = typeof row.label === "string" ? row.label : "";
  const idx = positiveNumber(row.idx);
  const width = positiveNumber(row.width);
  const height = positiveNumber(row.height);
  const bytes = positiveNumber(row.bytes);

  if (idx < 1 || idx > 40 || width < 1 || height < 1 || bytes < 1) {
    return null;
  }

  return {
    id,
    pageId,
    idx,
    label,
    status,
    pageStatus,
    storagePath: optionalString(row.storage_path),
    width,
    height,
    bytes,
    exportedAt: optionalString(row.exported_at),
    purgedAt: optionalString(row.purged_at),
    contributorId: optionalString(page?.contributor_id),
  };
}

export type OcrQueryOptions = {
  /** Export snapshots keep purged lines because the local image still exists. */
  includePurged: boolean;
  /** Optional single page, used by sync and purge. */
  pageId?: string;
};

export async function fetchApprovedOcrLines(
  supabase: SupabaseClient,
  options: OcrQueryOptions,
): Promise<OcrExportRecord[]> {
  if (options.pageId !== undefined && !isUuid(options.pageId)) {
    throw new Error("--page must be a page UUID");
  }
  const pageId = options.pageId?.toLowerCase();

  const rows: OcrExportRecord[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("ocr_lines")
      .select(
        "id, page_id, idx, label, status, storage_path, width, height, bytes, exported_at, purged_at, ocr_pages!inner(id, status, contributor_id)",
      )
      .eq("status", "approved")
      .eq("ocr_pages.status", "approved");

    if (!options.includePurged) {
      query = query.is("purged_at", null);
    }
    if (pageId) {
      query = query.eq("page_id", pageId);
    }

    const { data, error } = await query
      .order("page_id", { ascending: true })
      .order("idx", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Could not read approved OCR lines: ${error.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error("Could not read approved OCR lines: unexpected response");
    }

    const batch: unknown[] = data;
    for (const entry of batch) {
      const parsed = parseRow(entry);
      if (!parsed) {
        throw new Error("An approved OCR line has unusable database fields");
      }
      rows.push(parsed);
    }

    if (batch.length < PAGE_SIZE) break;
  }

  return rows;
}
