"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  plainTextFieldErrors,
  plainTextHash,
  plainTextSubmissionSchema,
} from "@/lib/khowar";
import type {
  PlainTextPageResult,
  PlainTextSubmitInput,
  PlainTextSubmitResult,
} from "@/lib/plain-text";
import {
  getPlainTextPage,
  parseTextSubmissionRow,
} from "@/lib/plain-text-server";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the plain text form. The session is checked again here
 * because server functions are reachable by direct POST too, and the database
 * policy forces the row to the caller, submitted, with no reviewer fields.
 */

async function requireUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user.id;
}

const offsetSchema = z.number().int().min(0).max(1_000_000);

export async function submitPlainText(
  input: PlainTextSubmitInput,
): Promise<PlainTextSubmitResult> {
  const userId = await requireUserId();

  const parsed = plainTextSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    const errors = plainTextFieldErrors(parsed.error);
    if (Object.keys(errors).length === 0) {
      return { status: "error", message: "That submission could not be read." };
    }
    return { status: "invalid", errors };
  }

  const data = parsed.data;
  const textHash = await plainTextHash(data.khowar_text);
  const supabase = await createClient();

  const { data: inserted, error } = await supabase
    .from("text_submissions")
    .insert({
      contributor_id: userId,
      title: data.title,
      khowar_text: data.khowar_text,
      source_note: data.source_note,
      rights_confirmed: true,
      text_hash: textHash,
      status: "submitted",
      reviewer_id: null,
      review_note: null,
    })
    .select("id, title, khowar_text, status, review_note, created_at")
    .single();

  if (error) {
    logRpcError("[submit_text]", error);
    if (error.code === "23505") {
      return {
        status: "duplicate",
        message: "This text has already been submitted.",
      };
    }
    return {
      status: "error",
      message: "The text could not be saved. Your text is still here.",
    };
  }

  const item = parseTextSubmissionRow(inserted);
  if (!item) {
    return {
      status: "error",
      message:
        "The text was saved, but it could not be shown. Reload the page to see it.",
    };
  }

  revalidatePath("/plain-text");
  revalidatePath("/dashboard");
  revalidatePath("/admin");

  return { status: "submitted", item };
}

/** One more page of the caller's own submissions, newest first. */
export async function loadMorePlainText(
  offset: number,
): Promise<PlainTextPageResult> {
  const userId = await requireUserId();

  const parsed = offsetSchema.safeParse(offset);
  if (!parsed.success) {
    return { status: "error", message: "The next page could not be loaded." };
  }

  const page = await getPlainTextPage(userId, parsed.data);
  if (!page) {
    return {
      status: "error",
      message: "The next page could not be loaded. Try again.",
    };
  }

  return { status: "loaded", page };
}
