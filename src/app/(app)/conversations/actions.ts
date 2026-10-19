"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  parseConversationRow,
  type ClaimResult,
  type ReportInput,
  type ReportResult,
  type SkipResult,
  type SubmitInput,
  type SubmitResult,
  type WorkspaceData,
} from "@/lib/conversations";
import { getPersonalConversationSummary } from "@/lib/conversations-server";
import {
  conversationRoles,
  validateConversationTranslation,
  type ConversationSource,
  type ConversationTranslationValues,
} from "@/lib/khowar";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the conversations workspace. Each one rechecks the session
 * and the claim, because server functions are reachable by direct POST too, and
 * submit_conversation_translation rechecks the turns inside the database.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

async function requireUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user.id;
}

async function claimNextConversation(db: Db): Promise<ClaimResult> {
  const { data, error } = await db.rpc("claim_next", { p_kind: "conversation" });

  if (error) {
    logRpcError("[claim_conversation]", error);
    return {
      status: "error",
      message: "The next conversation could not be loaded. Try again in a moment.",
    };
  }

  const rows: unknown[] = Array.isArray(data) ? data : [];
  if (rows.length === 0) return { status: "empty" };

  const item = parseConversationRow(rows[0]);
  if (!item) {
    return {
      status: "error",
      message:
        "That conversation's English turns are incomplete. An admin has to fix it.",
    };
  }

  return { status: "claimed", item };
}

async function withCounts(
  userId: string,
  claim: ClaimResult,
): Promise<WorkspaceData> {
  const { counts, submitted } = await getPersonalConversationSummary(userId);
  return { claim, counts, submitted };
}

async function hasLiveClaim(db: Db, userId: string, itemId: string) {
  const { data, error } = await db
    .from("claims")
    .select("expires_at")
    .eq("kind", "conversation")
    .eq("item_id", itemId)
    .eq("contributor_id", userId)
    .maybeSingle();

  if (error || !data) return false;
  const expiresAt = (data as { expires_at: string }).expires_at;
  return new Date(expiresAt).getTime() > Date.now();
}

/** Claim the next conversation for this contributor. */
export async function claimConversation(): Promise<WorkspaceData> {
  const userId = await requireUserId();
  const db = await createClient();
  return withCounts(userId, await claimNextConversation(db));
}

const turnsSchema = z
  .array(
    z.object({
      role: z.enum(conversationRoles),
      content: z.string(),
    }),
  )
  .min(1)
  .max(20);

const submitSchema = z.object({
  itemId: z.uuid(),
  english: turnsSchema,
  turns: turnsSchema,
  acknowledgeWarnings: z.boolean(),
});

/** Validate with the shared schema, save, release the claim, claim the next. */
export async function submitConversation(
  input: SubmitInput,
): Promise<SubmitResult> {
  const userId = await requireUserId();

  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "That submission could not be read. Open the conversation again.",
    };
  }

  const source: ConversationSource = { turns: parsed.data.english };
  const values: ConversationTranslationValues = { turns: parsed.data.turns };

  const validation = validateConversationTranslation(source, values);
  if (!validation.success) {
    return { status: "invalid", errors: validation.errors };
  }
  if (validation.warnings.length > 0 && !parsed.data.acknowledgeWarnings) {
    return { status: "warnings", warnings: validation.warnings };
  }

  const db = await createClient();

  // An expired claim is not an error: reload a claim before writing anything,
  // so nothing is lost when the same conversation comes back.
  if (!(await hasLiveClaim(db, userId, parsed.data.itemId))) {
    return {
      status: "expired",
      workspace: await withCounts(userId, await claimNextConversation(db)),
    };
  }

  const { error } = await db.rpc("submit_conversation_translation", {
    p_item_id: parsed.data.itemId,
    p_turns: parsed.data.turns,
  });

  if (error) {
    logRpcError("[submit_conversation]", error);
    const message = error.message ?? "";
    if (
      message.includes("CLAIM_EXPIRED") ||
      message.includes("ALREADY_SUBMITTED")
    ) {
      return {
        status: "expired",
        workspace: await withCounts(userId, await claimNextConversation(db)),
      };
    }
    if (message.includes("INVALID_TURNS")) {
      return {
        status: "error",
        message:
          "The server did not accept the turns. Reload the conversation and try again.",
      };
    }
    return {
      status: "error",
      message: "The translation could not be saved. Your text is still here.",
    };
  }

  revalidatePath("/conversations");
  revalidatePath("/dashboard");

  return {
    status: "submitted",
    workspace: await withCounts(userId, await claimNextConversation(db)),
  };
}

/** Skip: release the caller's claim, then hand out the next conversation. */
export async function skipConversation(itemId: string): Promise<SkipResult> {
  const userId = await requireUserId();

  const parsed = z.uuid().safeParse(itemId);
  if (!parsed.success) {
    return { status: "error", message: "That conversation could not be read." };
  }

  const db = await createClient();
  const { error } = await db.rpc("release_claim", { p_item_id: parsed.data });
  if (error) {
    logRpcError("[release_claim]", error);
    return {
      status: "error",
      message: "The conversation could not be released. Try again.",
    };
  }

  return {
    status: "skipped",
    workspace: await withCounts(userId, await claimNextConversation(db)),
  };
}

const reportSchema = z.object({
  itemId: z.uuid(),
  note: z
    .string()
    .trim()
    .min(1, "Add a short note about the problem")
    .max(2000, "Keep the note under 2000 characters"),
});

/** Report an issue with the English conversation, release, claim the next. */
export async function reportConversationIssue(
  input: ReportInput,
): Promise<ReportResult> {
  const userId = await requireUserId();

  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "invalid",
      message:
        parsed.error.issues[0]?.message ?? "Add a short note about the problem.",
    };
  }

  const db = await createClient();

  const { error: insertError } = await db.from("report_issues").insert({
    kind: "conversation",
    item_id: parsed.data.itemId,
    contributor_id: userId,
    note: parsed.data.note,
  });
  if (insertError) {
    return { status: "error", message: "The issue could not be saved. Try again." };
  }

  const { error: releaseError } = await db.rpc("release_claim", {
    p_item_id: parsed.data.itemId,
  });
  if (releaseError) {
    logRpcError("[release_claim]", releaseError);
    return {
      status: "error",
      message:
        "The issue was saved, but the conversation could not be released. Try again.",
    };
  }

  return {
    status: "reported",
    workspace: await withCounts(userId, await claimNextConversation(db)),
  };
}
