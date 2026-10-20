"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getProfile, getSessionUser } from "@/lib/auth";
import {
  isReviewKind,
  reviewConversationSchema,
  reviewInstructionSchema,
  reviewOcrSchema,
  reviewTextSchema,
  type ReviewDecisionInput,
  type ReviewDecisionResult,
  type ReviewKind,
  type ReviewQueue,
} from "@/lib/review";
import { getReviewQueue, refreshOcrReviewImages } from "@/lib/review-server";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the review page. Every action checks the session and the
 * role again, then validates the same zod schema the client used. The database
 * functions repeat the role, self review and status checks, so a direct POST
 * cannot skip a rule.
 */

const FORBIDDEN_MESSAGE = "Your account cannot review right now.";
const AUTH_MESSAGE = "Your session expired. Sign in again, then retry.";

type Reviewer = { userId: string };

async function requireReviewer(): Promise<Reviewer | null> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getProfile(user.id);
  if (!profile || (profile.role !== "reviewer" && profile.role !== "admin")) {
    return null;
  }

  return { userId: user.id };
}

function errorQueue(kind: ReviewKind, message: string): ReviewQueue {
  return { status: "error", kind, message };
}

/** One queue, requested when the reviewer switches tabs. */
export async function loadReviewQueue(kind: unknown): Promise<ReviewQueue> {
  const queueKind: ReviewKind = isReviewKind(kind) ? kind : "instruction";

  const reviewer = await requireReviewer();
  if (!reviewer) return errorQueue(queueKind, FORBIDDEN_MESSAGE);

  return getReviewQueue(reviewer.userId, queueKind);
}

const uuidSchema = z.uuid();

export type RefreshImagesResult =
  | { status: "refreshed"; urls: Record<number, string> }
  | { status: "error"; message: string };

/** New one hour signed URLs after an image failed to load. */
export async function refreshReviewImages(
  pageId: unknown,
): Promise<RefreshImagesResult> {
  const reviewer = await requireReviewer();
  if (!reviewer) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = uuidSchema.safeParse(pageId);
  if (!parsed.success) {
    return { status: "error", message: "That page could not be read." };
  }

  const refreshed = await refreshOcrReviewImages(parsed.data);
  if (!refreshed) {
    return {
      status: "error",
      message: "The images could not be signed again. Reload the page to retry.",
    };
  }

  return { status: "refreshed", urls: refreshed.urls };
}

function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "That review could not be read.";
}

/** Applies one decision. Returns the next queue so the page never goes stale. */
export async function submitReviewDecision(
  input: unknown,
): Promise<ReviewDecisionResult> {
  const reviewer = await requireReviewer();
  if (!reviewer) return { status: "blocked", message: FORBIDDEN_MESSAGE };

  if (!input || typeof input !== "object") {
    return { status: "blocked", message: "That review could not be read." };
  }

  const kind = (input as { kind?: unknown }).kind;
  if (!isReviewKind(kind)) {
    return { status: "blocked", message: "That review could not be read." };
  }

  const decision = (input as { decision?: unknown }).decision;
  const note = (input as { note?: unknown }).note;
  const base = {
    kind,
    decision,
    note,
  };
  const payload: Record<string, unknown> = {
    ...(input as Record<string, unknown>),
    ...base,
  };

  // Rejection never validates the submitted content. Replace the content fields
  // with placeholders so even a malformed submission can be rejected with a
  // note. The RPC ignores these fields when the decision is reject.
  if (decision === "reject") {
    if (kind === "instruction") {
      payload.english = { instruction: ".", input: null, response: "." };
      payload.values = {
        khowar_instruction: "",
        khowar_input: "",
        khowar_response: "",
      };
    } else if (kind === "conversation") {
      const placeholderTurns = [{ role: "user", content: "." }];
      payload.englishTurns = placeholderTurns;
      payload.turns = placeholderTurns;
    } else if (kind === "text") {
      payload.text = "";
    } else {
      payload.lines = [];
    }
  }

  const supabase = await createClient();
  let rpcError: { message: string; code?: string | null } | null = null;

  if (kind === "instruction") {
    const parsed = reviewInstructionSchema().safeParse(payload);
    if (!parsed.success) {
      return { status: "blocked", message: firstIssueMessage(parsed.error) };
    }

    const data = parsed.data;
    const result = await supabase.rpc("review_instruction", {
      p_translation_id: data.translationId,
      p_decision: data.decision,
      p_instruction: data.values.khowar_instruction,
      p_input:
        data.values.khowar_input.trim() === ""
          ? null
          : data.values.khowar_input,
      p_response: data.values.khowar_response,
      p_note: data.note,
    });
    rpcError = result.error;
  } else if (kind === "conversation") {
    const parsed = reviewConversationSchema().safeParse(payload);
    if (!parsed.success) {
      return { status: "blocked", message: firstIssueMessage(parsed.error) };
    }

    const data = parsed.data;
    const result = await supabase.rpc("review_conversation", {
      p_translation_id: data.translationId,
      p_decision: data.decision,
      p_turns: data.turns,
      p_note: data.note,
    });
    rpcError = result.error;
  } else if (kind === "text") {
    const parsed = reviewTextSchema().safeParse(payload);
    if (!parsed.success) {
      return { status: "blocked", message: firstIssueMessage(parsed.error) };
    }

    const data = parsed.data;
    const result = await supabase.rpc("review_text", {
      p_submission_id: data.submissionId,
      p_decision: data.decision,
      p_text: data.text,
      p_note: data.note,
    });
    rpcError = result.error;
  } else {
    const parsed = reviewOcrSchema().safeParse(payload);
    if (!parsed.success) {
      return { status: "blocked", message: firstIssueMessage(parsed.error) };
    }

    const data = parsed.data;
    const result = await supabase.rpc("review_ocr_page", {
      p_page_id: data.pageId,
      p_decision: data.decision,
      p_note: data.note,
      p_lines:
        data.decision === "approve"
          ? data.lines.map((line) => ({
              idx: line.idx,
              label: line.label,
              reject: line.reject,
            }))
          : [],
    });
    rpcError = result.error;
  }

  if (rpcError) {
    logRpcError("[review_decision]", rpcError);
    return blockedFromError(kind, rpcError.message, reviewer.userId);
  }

  revalidatePath("/review");
  revalidatePath("/dashboard");
  revalidatePath("/admin");

  const queue = await getReviewQueue(reviewer.userId, kind);
  const message =
    (input as { decision?: unknown }).decision === "reject"
      ? "Rejected with a note. The next item is ready."
      : kind === "ocr"
        ? "Page approved. The next page is ready."
        : "Approved. The next item is ready.";

  return { status: "decided", queue, message };
}

async function blockedFromError(
  kind: ReviewKind,
  raw: string,
  userId: string,
): Promise<ReviewDecisionResult> {
  const message = raw ?? "";

  if (message.includes("ALREADY_REVIEWED")) {
    return {
      status: "blocked",
      message: "Someone else already reviewed this item. Loading the next one.",
      queue: await getReviewQueue(userId, kind),
    };
  }
  if (message.includes("REVIEW_NOT_FOUND")) {
    return {
      status: "blocked",
      message: "This item is no longer available. Loading the next one.",
      queue: await getReviewQueue(userId, kind),
    };
  }
  if (message.includes("SELF_REVIEW")) {
    return {
      status: "blocked",
      message: "You cannot review your own contribution.",
    };
  }
  if (message.includes("REVIEW_NOTE_REQUIRED")) {
    return {
      status: "blocked",
      message: "Add a note of at least 3 characters before rejecting.",
    };
  }
  if (message.includes("REVIEW_INVALID_NOTE")) {
    return { status: "blocked", message: "Keep the note under 2000 characters." };
  }
  if (message.includes("REVIEW_INVALID_TURNS")) {
    return {
      status: "blocked",
      message: "Every turn needs Khowar text and must keep the English order.",
    };
  }
  if (message.includes("REVIEW_INVALID_LABEL")) {
    return {
      status: "blocked",
      message: "Every kept line needs a label under 400 characters.",
    };
  }
  if (message.includes("REVIEW_INVALID_LINES")) {
    return {
      status: "blocked",
      message: "The line list could not be read. Reload the page and retry.",
    };
  }
  if (message.includes("REVIEW_EMPTY_PAGE")) {
    return {
      status: "blocked",
      message: "Keep at least one line before approving the page.",
    };
  }
  if (message.includes("DUPLICATE_TEXT")) {
    return {
      status: "blocked",
      message: "An approved text already has this content. Edit it or reject.",
    };
  }
  if (message.includes("REVIEW_INVALID_CONTENT")) {
    return {
      status: "blocked",
      message: "The Khowar text does not pass the content rules yet.",
    };
  }
  if (message.includes("REVIEW_FORBIDDEN")) {
    return { status: "blocked", message: FORBIDDEN_MESSAGE };
  }
  if (message.includes("REVIEW_AUTH_REQUIRED")) {
    return { status: "blocked", message: AUTH_MESSAGE };
  }

  return {
    status: "blocked",
    message: "The review could not be saved. Your changes are still here.",
  };
}

/** Re-exported for the client components so the union stays one source. */
export type { ReviewDecisionInput };
