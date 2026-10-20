"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { validateLabel } from "@/lib/ocr/labels";
import { logOcrSubmitError } from "@/lib/ocr/log";
import type { OcrPagesPage } from "@/lib/ocr/pages";
import { getOcrPagesPage } from "@/lib/ocr/ocr-server";
import { MAX_UPLOAD_BYTES } from "@/lib/ocr/submit";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for OCR submit and My pages. The session is checked again in
 * every action because a server action is reachable by a direct POST. Labels
 * are re-validated here with the same shared rules the browser uses.
 */

const OCR_FULL_MESSAGE =
  "OCR uploads are full for now. Plain text, instructions and conversations are still open.";
const OCR_RATE_MESSAGE =
  "You have reached today's page limit. Please come back tomorrow.";

async function requireUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user.id;
}

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );

const createSchema = z.object({
  label: z.string().trim().max(120),
  rights: z.literal(true),
  lineCount: z.number().int().min(1).max(40),
  totalBytes: z.number().int().min(1).max(80_000_000),
});

const finalizeLineSchema = z.object({
  idx: z.number().int().min(1).max(40),
  storagePath: z.string().min(1).max(512),
  label: z.string().min(1).max(400),
  width: z.number().int().min(1).max(100_000),
  height: z.number().int().min(1).max(100_000),
  bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

const finalizeSchema = z.object({
  pageId: uuidSchema,
  lines: z.array(finalizeLineSchema).min(1).max(40),
});

const offsetSchema = z.number().int().min(0).max(1_000_000);

export type CreateOcrPageResult =
  | { status: "created"; pageId: string }
  | { status: "error"; message: string };

export type FinalizeLineInput = z.infer<typeof finalizeLineSchema>;

export type FinalizeOcrPageResult =
  | { status: "finalized"; lineCount: number }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

/**
 * Reserve a page row before any bytes are sent. The database function enforces
 * the rights flag, the line count, the 80 percent quota and the 20 pages per
 * 24 hours rate limit.
 */
export async function createOcrPage(input: {
  label: string;
  rights: boolean;
  lineCount: number;
  totalBytes: number;
}): Promise<CreateOcrPageResult> {
  await requireUserId();

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "The page details could not be read. Your labels are still here.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ocr_create_page", {
    p_label: parsed.data.label,
    p_rights: parsed.data.rights,
    p_line_count: parsed.data.lineCount,
    p_total_bytes: parsed.data.totalBytes,
  });

  if (error) {
    logOcrSubmitError(error);
    const message = error.message ?? "";

    if (message.includes("OCR_STORAGE_FULL")) {
      return { status: "error", message: OCR_FULL_MESSAGE };
    }
    if (message.includes("OCR_RATE_LIMIT")) {
      return { status: "error", message: OCR_RATE_MESSAGE };
    }
    if (message.includes("OCR_RIGHTS_REQUIRED")) {
      return {
        status: "error",
        message: "Confirm the rights statement before you submit.",
      };
    }
    if (message.includes("OCR_AUTH_REQUIRED")) {
      return {
        status: "error",
        message: "Your session expired. Sign in again, then retry.",
      };
    }

    return {
      status: "error",
      message:
        "The page could not be started. Your labels are still in this browser.",
    };
  }

  if (typeof data !== "string" || data === "") {
    return {
      status: "error",
      message: "The page was not created. Your labels are still in this browser.",
    };
  }

  return { status: "created", pageId: data };
}

/** Re-validate every label, then insert the lines and mark the page submitted. */
export async function finalizeOcrPage(input: {
  pageId: string;
  lines: FinalizeLineInput[];
}): Promise<FinalizeOcrPageResult> {
  const userId = await requireUserId();

  const parsed = finalizeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      message:
        "Some line details did not pass the server checks. Your draft is still here.",
    };
  }

  const seen = new Set<number>();
  const lines: Array<{
    idx: number;
    storage_path: string;
    label: string;
    width: number;
    height: number;
    bytes: number;
  }> = [];

  for (const line of parsed.data.lines) {
    if (seen.has(line.idx)) {
      return {
        status: "invalid",
        message:
          "Two lines have the same number. Go back to the line review and check the page.",
      };
    }
    seen.add(line.idx);

    const label = validateLabel(line.label);
    if (!label.ok) {
      return {
        status: "invalid",
        message: `Line ${line.idx}: ${label.error}`,
      };
    }

    const prefix = `${userId}/${parsed.data.pageId}/`;
    if (!line.storagePath.startsWith(prefix)) {
      return {
        status: "invalid",
        message:
          "A line image path did not match this page. Go back to the line review and try again.",
      };
    }

    lines.push({
      idx: line.idx,
      storage_path: line.storagePath,
      label: label.value,
      width: line.width,
      height: line.height,
      bytes: line.bytes,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ocr_finalize_page", {
    p_page_id: parsed.data.pageId,
    p_lines: lines,
  });

  if (error) {
    logOcrSubmitError(error);
    const message = error.message ?? "";

    if (message.includes("OCR_PAGE_NOT_FOUND")) {
      return {
        status: "error",
        message:
          "This submission is no longer available. Start a new page from the upload step.",
      };
    }
    if (message.includes("OCR_PAGE_NOT_EDITABLE")) {
      return {
        status: "error",
        message:
          "This page was already submitted or closed. Check My pages below.",
      };
    }
    if (message.includes("OCR_AUTH_REQUIRED")) {
      return {
        status: "error",
        message: "Your session expired. Sign in again, then retry.",
      };
    }

    return {
      status: "error",
      message:
        "The page could not be finalized. All uploaded lines are still saved; retry in a moment.",
    };
  }

  revalidatePath("/ocr");
  revalidatePath("/dashboard");
  revalidatePath("/admin");

  const lineCount =
    typeof data === "number" ? data : parsed.data.lines.length;

  return { status: "finalized", lineCount };
}

/** Mark an unfinished page failed. Used by Cancel submission. */
export async function abortOcrPage(
  pageId: string,
): Promise<{ ok: boolean }> {
  await requireUserId();

  const parsed = uuidSchema.safeParse(pageId);
  if (!parsed.success) return { ok: false };

  const supabase = await createClient();
  const { error } = await supabase.rpc("ocr_abort_page", {
    p_page_id: parsed.data,
  });

  if (error) {
    logOcrSubmitError(error);
    return { ok: false };
  }

  revalidatePath("/ocr");
  revalidatePath("/dashboard");
  revalidatePath("/admin");
  return { ok: true };
}

/** One more page of the caller's own OCR pages. */
export async function loadMoreOcrPages(offset: number): Promise<
  | { status: "loaded"; page: OcrPagesPage }
  | { status: "error"; message: string }
> {
  const userId = await requireUserId();
  const parsed = offsetSchema.safeParse(offset);

  if (!parsed.success) {
    return { status: "error", message: "The next page could not be loaded." };
  }

  const page = await getOcrPagesPage(userId, parsed.data);
  if (!page) {
    return {
      status: "error",
      message: "The next page could not be loaded. Try again.",
    };
  }

  return { status: "loaded", page };
}
