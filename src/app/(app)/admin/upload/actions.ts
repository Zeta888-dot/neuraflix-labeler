"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { canImport } from "@/lib/admin/upload/access";
import { buildErrorCsv } from "@/lib/admin/upload/csv";
import {
  parseChunkResult,
  parseImportSource,
} from "@/lib/admin/upload/parse";
import type {
  ChunkResult,
  ImportErrorRow,
  ImportSource,
  UploadStatus,
} from "@/lib/admin/upload/types";
import {
  getAllImportErrors,
  getImportErrors,
  getImportSources,
  getUploadStatus,
} from "@/lib/admin/upload/upload-server";
import { getProfile, getSessionUser } from "@/lib/auth";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the admin text import. Every action checks the admin role
 * before it calls the database, and every RPC checks is_admin() again. A
 * non-admin gets a 404 from the page and a forbidden result from the action.
 */

const AUTH_MESSAGE = "Your session expired. Sign in again, then retry.";
const FORBIDDEN_MESSAGE = "Your account cannot load data.";
const GENERIC_MESSAGE = "The import request failed. Try again.";
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function genericMessage(code?: string | null): string {
  return code ? `The import request failed (${code}). Try again.` : GENERIC_MESSAGE;
}

function safeErrorCode(error: {
  message?: string;
  code?: string | null;
}): string | null {
  const message = typeof error.message === "string" ? error.message : "";
  const marker = message.match(/\b(?:IMPORT|ADMIN)_[A-Z0-9_]+\b/);
  if (marker) return marker[0];

  if (typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)) {
    return error.code;
  }

  return null;
}

async function requireAdminId(): Promise<string | null> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getProfile(user.id);
  if (!canImport(profile?.role)) return null;
  return user.id;
}

function actionError(error: { message?: string; code?: string | null }): string {
  const message =
    typeof error.message === "string" ? error.message : "";

  if (message.includes("ADMIN_AUTH_REQUIRED")) return AUTH_MESSAGE;
  if (message.includes("ADMIN_FORBIDDEN")) return FORBIDDEN_MESSAGE;
  if (message.includes("IMPORT_KIND_UNSUPPORTED")) {
    return "Only instruction imports are available in this phase.";
  }
  if (message.includes("IMPORT_PAUSE_DB")) {
    return "The database is at its pause threshold. Free space or raise the quota before loading more.";
  }
  if (message.includes("IMPORT_PAUSE_QUEUE")) {
    return "Open instruction items are at the pause threshold. Finish or retire items before loading more.";
  }
  if (message.includes("IMPORT_PAUSED")) {
    return "This import is paused. Resume it before loading another chunk.";
  }
  if (message.includes("IMPORT_COMPLETED")) {
    return "This import is already complete.";
  }
  if (message.includes("IMPORT_SOURCE_CLOSED")) {
    return "This import is closed. Select a new file.";
  }
  if (
    message.includes("IMPORT_CHUNK_OUT_OF_ORDER") ||
    message.includes("IMPORT_OFFSET_MISMATCH") ||
    message.includes("IMPORT_CHUNK_CONFLICT")
  ) {
    return "The saved position did not match this chunk. Select the same file again to resume.";
  }
  if (message.includes("IMPORT_CHUNK_TOO_LARGE")) {
    return "This chunk is too large. Lower the chunk size and select the file again.";
  }
  if (message.includes("IMPORT_ROW_LIMIT")) {
    return "This import reached the 250,000 row limit. Split the file.";
  }
  if (message.includes("IMPORT_EMPTY_CHUNK")) {
    return "This chunk has no rows. Select the file again.";
  }
  if (message.includes("IMPORT_NOT_COMPLETE")) {
    return "This import has not reached the end of the file.";
  }
  if (message.includes("IMPORT_SOURCE_NOT_FOUND")) {
    return "This import could not be found. Reload the page.";
  }
  if (message.includes("IMPORT_INVALID_")) {
    return "The import request was not valid. Reload the page and try again.";
  }

  return genericMessage(safeErrorCode(error));
}

const createSourceSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z.number().int().min(1).max(209_715_200),
  fileHash: z.string().regex(HASH_PATTERN),
  sourceLabel: z.string().trim().min(1).max(120),
  targetCount: z.number().int().min(1).max(5),
  chunkSize: z.number().int().min(20).max(1000),
});

export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export async function createImportSourceAction(
  input: CreateSourceInput,
): Promise<
  | { status: "ok"; source: ImportSource }
  | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = createSourceSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The file details were not valid." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_import_create_source", {
    p_kind: "instruction",
    p_file_name: parsed.data.fileName,
    p_file_size: parsed.data.fileSize,
    p_file_hash: parsed.data.fileHash,
    p_source_label: parsed.data.sourceLabel,
    p_target_count: parsed.data.targetCount,
    p_chunk_size: parsed.data.chunkSize,
  });

  if (error) {
    logRpcError("[admin_import_create_source]", error);
    return { status: "error", message: actionError(error) };
  }

  const rows = Array.isArray(data) ? data : [];
  const source = parseImportSource(rows[0]);
  if (!source) {
    logRpcError("[admin_import_create_source]", {
      message: "Unexpected admin_import_create_source payload",
      code: "UPLOAD_PARSE",
    });
    return { status: "error", message: genericMessage("UPLOAD_PARSE") };
  }

  revalidatePath("/admin/upload");
  return { status: "ok", source };
}

const chunkSchema = z
  .object({
    sourceId: z.uuid(),
    chunkIndex: z.number().int().min(0),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    contentHash: z.string().regex(HASH_PATTERN),
    rows: z
      .array(
        z.object({
          raw: z.string().max(716_800),
        }),
      )
      .max(1000),
  })
  .refine((value) => value.endOffset >= value.startOffset, {
    message: "The chunk offsets are not valid.",
  });

export type LoadChunkInput = z.infer<typeof chunkSchema>;

export async function loadTextChunkAction(
  input: LoadChunkInput,
): Promise<
  | { status: "ok"; result: ChunkResult }
  | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = chunkSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The chunk was not valid." };
  }

  const rawBytes = parsed.data.rows.reduce(
    (total, row) => total + new TextEncoder().encode(row.raw).length,
    0,
  );
  if (rawBytes > 1_048_576) {
    return { status: "error", message: "This chunk is too large." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_import_text_chunk", {
    p_source_id: parsed.data.sourceId,
    p_chunk_index: parsed.data.chunkIndex,
    p_start_offset: parsed.data.startOffset,
    p_end_offset: parsed.data.endOffset,
    p_content_hash: parsed.data.contentHash,
    p_rows: parsed.data.rows,
  });

  if (error) {
    logRpcError("[admin_import_text_chunk]", error);
    return { status: "error", message: actionError(error) };
  }

  const rows = Array.isArray(data) ? data : [];
  const result = parseChunkResult(rows[0]);
  if (!result) {
    logRpcError("[admin_import_text_chunk]", {
      message: "Unexpected admin_import_text_chunk payload",
      code: "UPLOAD_PARSE",
    });
    return { status: "error", message: genericMessage("UPLOAD_PARSE") };
  }

  revalidatePath("/admin/upload");
  revalidatePath("/admin");
  return { status: "ok", result };
}

const statusSchema = z.object({
  sourceId: z.uuid(),
  status: z.enum(["active", "paused", "abandoned", "completed"]),
});

export type SetStatusInput = z.infer<typeof statusSchema>;

export async function setImportStatusAction(
  input: SetStatusInput,
): Promise<
  { status: "ok"; sourceStatus: string } | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The status was not valid." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_import_set_status", {
    p_source_id: parsed.data.sourceId,
    p_status: parsed.data.status,
  });

  if (error) {
    logRpcError("[admin_import_set_status]", error);
    return { status: "error", message: actionError(error) };
  }

  revalidatePath("/admin/upload");
  return { status: "ok", sourceStatus: typeof data === "string" ? data : parsed.data.status };
}

const verifyResumeSchema = z.object({
  sourceId: z.uuid(),
  chunkIndex: z.number().int().min(0),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  contentHash: z.string().regex(HASH_PATTERN),
});

export type VerifyResumeInput = z.infer<typeof verifyResumeSchema>;

export async function verifyResumeAnchorAction(
  input: VerifyResumeInput,
): Promise<{ status: "ok"; matched: boolean } | { status: "error"; message: string }> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = verifyResumeSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The resume position was not valid." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_import_verify_resume", {
    p_source_id: parsed.data.sourceId,
    p_chunk_index: parsed.data.chunkIndex,
    p_start_offset: parsed.data.startOffset,
    p_end_offset: parsed.data.endOffset,
    p_content_hash: parsed.data.contentHash,
  });

  if (error) {
    logRpcError("[admin_import_verify_resume]", error);
    return { status: "error", message: actionError(error) };
  }

  return { status: "ok", matched: data === true };
}

export async function getUploadStatusAction(): Promise<
  | { status: "ok"; uploadStatus: UploadStatus }
  | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const uploadStatus = await getUploadStatus();
  if (!uploadStatus) return { status: "error", message: GENERIC_MESSAGE };

  return { status: "ok", uploadStatus };
}

export async function getImportSourcesAction(): Promise<
  { status: "ok"; sources: ImportSource[] } | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const sources = await getImportSources(20);
  if (!sources) return { status: "error", message: GENERIC_MESSAGE };

  return { status: "ok", sources };
}

const errorsSchema = z.object({
  sourceId: z.uuid(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(1000).default(50),
});

export type ImportErrorsInput = z.infer<typeof errorsSchema>;

export async function getImportErrorsAction(
  input: ImportErrorsInput,
): Promise<
  | { status: "ok"; totalCount: number; rows: ImportErrorRow[] }
  | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = errorsSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The error query was not valid." };
  }

  const page = await getImportErrors(
    parsed.data.sourceId,
    parsed.data.offset,
    parsed.data.limit,
  );
  if (!page) return { status: "error", message: GENERIC_MESSAGE };

  return { status: "ok", totalCount: page.totalCount, rows: page.rows };
}

const csvSchema = z.object({
  sourceId: z.uuid(),
  fileName: z.string().trim().min(1).max(255),
});

export type ErrorCsvInput = z.infer<typeof csvSchema>;

export async function downloadErrorCsvAction(
  input: ErrorCsvInput,
): Promise<
  | { status: "ok"; csv: string; fileName: string }
  | { status: "empty" }
  | { status: "error"; message: string }
> {
  const adminId = await requireAdminId();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = csvSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "The download request was not valid." };
  }

  const rows = await getAllImportErrors(parsed.data.sourceId);
  if (!rows) return { status: "error", message: GENERIC_MESSAGE };
  if (rows.length === 0) return { status: "empty" };

  const base = parsed.data.fileName.replace(/\.[^.]+$/, "");
  const safe = base.replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80) || "import";

  return {
    status: "ok",
    csv: buildErrorCsv(rows),
    fileName: `${safe}-errors.csv`,
  };
}
