import { emptyInstructionCounts, type InstructionCounts } from "@/lib/instructions";
import { createClient } from "@/lib/supabase/server";

/**
 * Server only reads for the instructions module and the dashboard. Every query
 * runs with the caller's session, so RLS narrows it to their own rows.
 */

const TRANSLATION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
] as const;

/** The signed-in contributor's instruction translations, counted by status. */
export async function getInstructionCounts(
  userId: string,
): Promise<InstructionCounts | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    TRANSLATION_STATUSES.map((status) =>
      supabase
        .from("instruction_translations")
        .select("id", { count: "exact", head: true })
        .eq("contributor_id", userId)
        .eq("status", status),
    ),
  );

  const counts: InstructionCounts = { ...emptyInstructionCounts };
  for (let index = 0; index < TRANSLATION_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") return null;
    counts[TRANSLATION_STATUSES[index]] = result.count;
  }

  return counts;
}

/** Submitted plus approved translations by one contributor. */
export async function getSubmittedTranslationCount(
  userId: string,
): Promise<number | null> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .from("instruction_translations")
    .select("id", { count: "exact", head: true })
    .eq("contributor_id", userId)
    .in("status", ["submitted", "approved"]);

  if (error || typeof count !== "number") return null;
  return count;
}

/** The personal counters the workspace and the dashboard show. */
export async function getPersonalInstructionSummary(userId: string): Promise<{
  counts: InstructionCounts | null;
  submitted: number | null;
}> {
  const [counts, submitted] = await Promise.all([
    getInstructionCounts(userId),
    getSubmittedTranslationCount(userId),
  ]);
  return { counts, submitted };
}

const ITEM_STATUSES = ["open", "complete", "retired"] as const;

export type InstructionItemCounts = Record<(typeof ITEM_STATUSES)[number], number>;

/** Every instruction item, counted by status. Staff only through RLS. */
export async function getInstructionItemCounts(): Promise<InstructionItemCounts | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    ITEM_STATUSES.map((status) =>
      supabase
        .from("instruction_items")
        .select("id", { count: "exact", head: true })
        .eq("status", status),
    ),
  );

  const counts: InstructionItemCounts = { open: 0, complete: 0, retired: 0 };
  for (let index = 0; index < ITEM_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") return null;
    counts[ITEM_STATUSES[index]] = result.count;
  }

  return counts;
}
