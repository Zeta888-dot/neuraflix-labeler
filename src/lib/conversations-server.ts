import {
  emptyConversationCounts,
  type ConversationCounts,
} from "@/lib/conversations";
import { createClient } from "@/lib/supabase/server";

/**
 * Server only reads for the conversations module and the dashboard. Every query
 * runs with the caller's session, so RLS narrows it to their own rows.
 */

const TRANSLATION_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "rejected",
] as const;

/** The signed-in contributor's conversation translations, counted by status. */
export async function getConversationCounts(
  userId: string,
): Promise<ConversationCounts | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    TRANSLATION_STATUSES.map((status) =>
      supabase
        .from("conversation_translations")
        .select("id", { count: "exact", head: true })
        .eq("contributor_id", userId)
        .eq("status", status),
    ),
  );

  const counts: ConversationCounts = { ...emptyConversationCounts };
  for (let index = 0; index < TRANSLATION_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") return null;
    counts[TRANSLATION_STATUSES[index]] = result.count;
  }

  return counts;
}

/** Submitted plus approved conversations by one contributor. */
export async function getSubmittedConversationCount(
  userId: string,
): Promise<number | null> {
  const supabase = await createClient();

  const { count, error } = await supabase
    .from("conversation_translations")
    .select("id", { count: "exact", head: true })
    .eq("contributor_id", userId)
    .in("status", ["submitted", "approved"]);

  if (error || typeof count !== "number") return null;
  return count;
}

/** The personal counters the workspace and the dashboard show. */
export async function getPersonalConversationSummary(userId: string): Promise<{
  counts: ConversationCounts | null;
  submitted: number | null;
}> {
  const [counts, submitted] = await Promise.all([
    getConversationCounts(userId),
    getSubmittedConversationCount(userId),
  ]);
  return { counts, submitted };
}

const ITEM_STATUSES = ["open", "complete", "retired"] as const;

export type ConversationItemCounts = Record<
  (typeof ITEM_STATUSES)[number],
  number
>;

/** Every conversation item, counted by status. Staff only through RLS. */
export async function getConversationItemCounts(): Promise<ConversationItemCounts | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    ITEM_STATUSES.map((status) =>
      supabase
        .from("conversation_items")
        .select("id", { count: "exact", head: true })
        .eq("status", status),
    ),
  );

  const counts: ConversationItemCounts = { open: 0, complete: 0, retired: 0 };
  for (let index = 0; index < ITEM_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") return null;
    counts[ITEM_STATUSES[index]] = result.count;
  }

  return counts;
}
