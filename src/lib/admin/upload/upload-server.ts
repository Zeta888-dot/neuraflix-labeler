import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";
import {
  parseImportErrorsPage,
  parseImportSource,
  parseUploadStatus,
} from "./parse";
import type { ImportErrorRow, ImportSource, UploadStatus } from "./types";

/**
 * Server reads for the admin upload page. Every RPC checks is_admin() inside
 * the database; the page and actions also check the profile before calling.
 */

export async function getUploadStatus(): Promise<UploadStatus | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_upload_status");

  if (error) {
    logRpcError("[admin_upload_status]", error);
    return null;
  }

  const status = parseUploadStatus(data);
  if (!status) {
    logRpcError("[admin_upload_status]", {
      message: "Unexpected admin_upload_status payload",
      code: "UPLOAD_PARSE",
    });
    return null;
  }

  return status;
}

export async function getImportSources(
  limit = 20,
): Promise<ImportSource[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_import_sources", {
    p_limit: limit,
  });

  if (error) {
    logRpcError("[admin_import_sources]", error);
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  return rows
    .map(parseImportSource)
    .filter(
      (source): source is ImportSource =>
        source !== null && source.kind === "instruction",
    );
}

export async function getImportErrors(
  sourceId: string,
  offset = 0,
  limit = 50,
): Promise<{ totalCount: number; rows: ImportErrorRow[] } | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_import_errors", {
    p_source_id: sourceId,
    p_offset: offset,
    p_limit: limit,
  });

  if (error) {
    logRpcError("[admin_import_errors]", error);
    return null;
  }

  return parseImportErrorsPage(data);
}

export async function getAllImportErrors(
  sourceId: string,
): Promise<ImportErrorRow[] | null> {
  const pageSize = 1000;
  const rows: ImportErrorRow[] = [];
  let offset = 0;

  for (;;) {
    const page = await getImportErrors(sourceId, offset, pageSize);
    if (!page) return null;

    rows.push(...page.rows);
    offset += page.rows.length;

    if (offset >= page.totalCount || page.rows.length === 0) break;
  }

  return rows;
}
