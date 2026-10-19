import {
  PLAIN_TEXT_PAGE_SIZE,
  PLAIN_TEXT_PREVIEW_CHARS,
  TEXT_SUBMISSION_STATUSES,
  emptyPlainTextCounts,
  isTextSubmissionStatus,
  type PlainTextCounts,
  type PlainTextPage,
  type PlainTextSubmission,
} from "@/lib/plain-text";
import { countCharacters, normalizeWhitespace } from "@/lib/khowar";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server only reads for the plain text module, the dashboard and admin. Every
 * query runs with the caller's session, so RLS narrows it to their own rows
 * (staff can read all rows, which the admin totals rely on).
 */

const ADMIN_CHUNK_SIZE = 1000;

const dateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function previewOf(text: string): string {
  const flat = normalizeWhitespace(text);
  const characters = Array.from(flat);
  if (characters.length <= PLAIN_TEXT_PREVIEW_CHARS) return flat;
  return `${characters.slice(0, PLAIN_TEXT_PREVIEW_CHARS).join("")}...`;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
}

/** One text_submissions row (snake_case from PostgREST) in the UI shape. */
export function parseTextSubmissionRow(
  value: unknown,
): PlainTextSubmission | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const id = typeof row.id === "string" ? row.id : null;
  const text = typeof row.khowar_text === "string" ? row.khowar_text : null;
  const createdAt =
    typeof row.created_at === "string" ? row.created_at : null;

  if (!id || text === null || !createdAt || !isTextSubmissionStatus(row.status)) {
    return null;
  }

  const title =
    typeof row.title === "string" && row.title.trim() !== ""
      ? row.title
      : null;
  const reviewNote =
    typeof row.review_note === "string" && row.review_note.trim() !== ""
      ? row.review_note
      : null;

  return {
    id,
    title,
    preview: previewOf(text),
    characters: countCharacters(text),
    status: row.status,
    reviewNote,
    createdAt,
    createdLabel: dateLabel(createdAt),
  };
}

/** The signed-in contributor's submissions, newest first, 20 per page. */
export async function getPlainTextPage(
  userId: string,
  offset = 0,
): Promise<PlainTextPage | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("text_submissions")
    .select("id, title, khowar_text, status, review_note, created_at")
    .eq("contributor_id", userId)
    .in("status", [...TEXT_SUBMISSION_STATUSES])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + PLAIN_TEXT_PAGE_SIZE);

  if (error) {
    logRpcError("[plain_text_page]", error);
    return null;
  }

  const rows: unknown[] = Array.isArray(data) ? data : [];
  const hasMore = rows.length > PLAIN_TEXT_PAGE_SIZE;
  const pageItems = rows
    .slice(0, PLAIN_TEXT_PAGE_SIZE)
    .map(parseTextSubmissionRow)
    .filter((item): item is PlainTextSubmission => item !== null);

  return {
    items: pageItems,
    nextOffset: hasMore ? offset + PLAIN_TEXT_PAGE_SIZE : null,
  };
}

/** The signed-in contributor's plain text submissions, counted by status. */
export async function getPlainTextCounts(
  userId: string,
): Promise<PlainTextCounts | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    TEXT_SUBMISSION_STATUSES.map((status) =>
      supabase
        .from("text_submissions")
        .select("id", { count: "exact", head: true })
        .eq("contributor_id", userId)
        .eq("status", status),
    ),
  );

  const counts: PlainTextCounts = { ...emptyPlainTextCounts };

  for (let index = 0; index < TEXT_SUBMISSION_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") {
      if (result.error) logRpcError("[plain_text_counts]", result.error);
      return null;
    }
    counts[TEXT_SUBMISSION_STATUSES[index]] = result.count;
  }

  return counts;
}

export type PlainTextAdminStats = PlainTextCounts & {
  characters: number;
};

/**
 * Every text submission, counted by status, plus the total characters stored.
 * RLS only lets staff read all rows; the admin page checks the role first.
 * The character total is read in pages so PostgREST's row cap cannot shorten it.
 */
export async function getPlainTextAdminStats(): Promise<PlainTextAdminStats | null> {
  const supabase = await createClient();

  const results = await Promise.all(
    TEXT_SUBMISSION_STATUSES.map((status) =>
      supabase
        .from("text_submissions")
        .select("id", { count: "exact", head: true })
        .eq("status", status),
    ),
  );

  const counts: PlainTextCounts = { ...emptyPlainTextCounts };

  for (let index = 0; index < TEXT_SUBMISSION_STATUSES.length; index += 1) {
    const result = results[index];
    if (result.error || typeof result.count !== "number") {
      if (result.error) logRpcError("[plain_text_admin_counts]", result.error);
      return null;
    }
    counts[TEXT_SUBMISSION_STATUSES[index]] = result.count;
  }

  let characters = 0;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("text_submissions")
      .select("khowar_text")
      .in("status", [...TEXT_SUBMISSION_STATUSES])
      .order("id", { ascending: true })
      .range(from, from + ADMIN_CHUNK_SIZE - 1);

    if (error) {
      logRpcError("[plain_text_admin_characters]", error);
      return null;
    }

    const rows: unknown[] = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const text = (row as Record<string, unknown>).khowar_text;
      if (typeof text === "string") characters += countCharacters(text);
    }

    if (rows.length < ADMIN_CHUNK_SIZE) break;
    from += ADMIN_CHUNK_SIZE;
  }

  return { ...counts, characters };
}
