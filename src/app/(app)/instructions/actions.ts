"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import {
  parseInstructionRow,
  type ClaimResult,
  type ReportInput,
  type ReportResult,
  type SkipResult,
  type SubmitInput,
  type SubmitResult,
  type WorkspaceData,
} from "@/lib/instructions";
import { getPersonalInstructionSummary } from "@/lib/instructions-server";
import {
  validateInstructionTranslation,
  type EnglishSource,
} from "@/lib/khowar";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the instructions workspace. Each one rechecks the session
 * and the claim, because server functions are reachable by direct POST too.
 */

type Db = Awaited<ReturnType<typeof createClient>>;

type RpcErrorFields = {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

/** Postgres error fields only: never the payload, the session or the row. */
function logRpcError(prefix: string, error: RpcErrorFields): void {
  console.error(prefix, {
    message: error.message,
    code: error.code ?? null,
    details: error.details ?? null,
    hint: error.hint ?? null,
  });
}

async function requireUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user.id;
}

async function claimNextInstruction(db: Db): Promise<ClaimResult> {
  const { data, error } = await db.rpc("claim_next", { p_kind: "instruction" });

  if (error) {
    logRpcError("[claim_next]", error);
    return {
      status: "error",
      message: "The next item could not be loaded. Try again in a moment.",
    };
  }

  const rows: unknown[] = Array.isArray(data) ? data : [];
  if (rows.length === 0) return { status: "empty" };

  const item = parseInstructionRow(rows[0]);
  if (!item) {
    return {
      status: "error",
      message: "That item's English payload is incomplete. An admin has to fix it.",
    };
  }

  return { status: "claimed", item };
}

async function withCounts(
  userId: string,
  claim: ClaimResult,
): Promise<WorkspaceData> {
  const { counts, submitted } = await getPersonalInstructionSummary(userId);
  return { claim, counts, submitted };
}

async function hasLiveClaim(db: Db, userId: string, itemId: string) {
  const { data, error } = await db
    .from("claims")
    .select("expires_at")
    .eq("kind", "instruction")
    .eq("item_id", itemId)
    .eq("contributor_id", userId)
    .maybeSingle();

  if (error || !data) return false;
  const expiresAt = (data as { expires_at: string }).expires_at;
  return new Date(expiresAt).getTime() > Date.now();
}

/** Claim the next instruction item for this contributor. */
export async function claimInstruction(): Promise<WorkspaceData> {
  const userId = await requireUserId();
  const db = await createClient();
  return withCounts(userId, await claimNextInstruction(db));
}

const englishSchema = z.object({
  instruction: z.string().min(1).max(8000),
  input: z.string().max(8000).nullish(),
  response: z.string().min(1).max(8000),
});

const valuesSchema = z.object({
  khowar_instruction: z.string().max(20000),
  khowar_input: z.string().max(20000),
  khowar_response: z.string().max(20000),
});

const submitSchema = z.object({
  itemId: z.uuid(),
  english: englishSchema,
  values: valuesSchema,
  acknowledgeWarnings: z.boolean(),
});

/** Validate with the shared schema, save, release the claim, claim the next. */
export async function submitInstruction(
  input: SubmitInput,
): Promise<SubmitResult> {
  const userId = await requireUserId();

  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      message: "That submission could not be read. Open the item again.",
    };
  }

  const english: EnglishSource = {
    instruction: parsed.data.english.instruction,
    input: parsed.data.english.input ?? null,
    response: parsed.data.english.response,
  };

  const validation = validateInstructionTranslation(english, parsed.data.values);
  if (!validation.success) {
    return { status: "invalid", errors: validation.errors };
  }
  if (validation.warnings.length > 0 && !parsed.data.acknowledgeWarnings) {
    return { status: "warnings", warnings: validation.warnings };
  }

  const db = await createClient();

  // An expired claim is not an error: reload a claim before writing anything,
  // so nothing is lost when the same item comes back.
  if (!(await hasLiveClaim(db, userId, parsed.data.itemId))) {
    return {
      status: "expired",
      workspace: await withCounts(userId, await claimNextInstruction(db)),
    };
  }

  const { error } = await db.rpc("submit_instruction_translation", {
    p_item_id: parsed.data.itemId,
    p_khowar_instruction: parsed.data.values.khowar_instruction,
    p_khowar_input: english.input ? parsed.data.values.khowar_input : null,
    p_khowar_response: parsed.data.values.khowar_response,
  });

  if (error) {
    logRpcError("[submit_instruction]", error);
    const message = error.message ?? "";
    if (
      message.includes("CLAIM_EXPIRED") ||
      message.includes("ALREADY_SUBMITTED")
    ) {
      return {
        status: "expired",
        workspace: await withCounts(userId, await claimNextInstruction(db)),
      };
    }
    return {
      status: "error",
      message: "The translation could not be saved. Your text is still here.",
    };
  }

  revalidatePath("/instructions");
  revalidatePath("/dashboard");

  return {
    status: "submitted",
    workspace: await withCounts(userId, await claimNextInstruction(db)),
  };
}

/** Skip: release the caller's claim, then hand out the next item. */
export async function skipInstruction(itemId: string): Promise<SkipResult> {
  const userId = await requireUserId();

  const parsed = z.uuid().safeParse(itemId);
  if (!parsed.success) {
    return { status: "error", message: "That item could not be read." };
  }

  const db = await createClient();
  const { error } = await db.rpc("release_claim", { p_item_id: parsed.data });
  if (error) {
    logRpcError("[release_claim]", error);
    return { status: "error", message: "The item could not be released. Try again." };
  }

  return {
    status: "skipped",
    workspace: await withCounts(userId, await claimNextInstruction(db)),
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

/** Report an issue with the English item, release the claim, claim the next. */
export async function reportInstructionIssue(
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
    kind: "instruction",
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
      message: "The issue was saved, but the item could not be released. Try again.",
    };
  }

  return {
    status: "reported",
    workspace: await withCounts(userId, await claimNextInstruction(db)),
  };
}
