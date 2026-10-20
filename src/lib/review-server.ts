import {
  parseFeedbackRows,
  parseReviewCounts,
  parseReviewItem,
  type FeedbackItem,
  type ReviewCounts,
  type ReviewItem,
  type ReviewKind,
  type ReviewOcrLine,
  type ReviewQueue,
} from "@/lib/review";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server only reads for the review queues, the OCR review viewer, the
 * contributor feedback block and the reviewer counter. Every call runs with
 * the caller's session. The review functions check the role in the database,
 * and the pages check it again before rendering.
 */

const SIGNED_URL_SECONDS = 3600;

const QUEUE_ERROR =
  "The review queue could not be loaded. Reload the page in a moment.";
const ITEM_ERROR =
  "The next item could not be loaded. Reload the page in a moment.";

type ReviewCountsResult = {
  counts: ReviewCounts;
  allowSelfReview: boolean;
};

/** Submitted rows per queue, plus the self review setting. */
export async function getReviewCounts(): Promise<ReviewCountsResult | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_counts");

  if (error) {
    logRpcError("[review_counts]", error);
    return null;
  }

  const parsed = parseReviewCounts(data);
  if (!parsed) {
    logRpcError("[review_counts]", {
      message: "Unexpected review_counts payload",
      code: "REVIEW_PARSE",
    });
    return null;
  }

  return parsed;
}

/** The caller's own review decisions, used as a personal counter. */
export async function getReviewsDone(userId: string): Promise<number | null> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("review_log")
    .select("id", { count: "exact", head: true })
    .eq("reviewer_id", userId);

  if (error || typeof count !== "number") {
    if (error) logRpcError("[review_done]", error);
    return null;
  }

  return count;
}

type SignedLineRow = {
  id: string;
  idx: number;
  label: string;
  width: number;
  height: number;
  storage_path: string | null;
};

function parseLineRow(value: unknown): SignedLineRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const id = typeof row.id === "string" ? row.id : null;
  const idx = Number(row.idx);
  const label = typeof row.label === "string" ? row.label : null;
  if (!id || !Number.isFinite(idx) || label === null) return null;

  const width = Number(row.width);
  const height = Number(row.height);

  return {
    id,
    idx: Math.trunc(idx),
    label,
    width: Number.isFinite(width) && width > 0 ? Math.trunc(width) : 0,
    height: Number.isFinite(height) && height > 0 ? Math.trunc(height) : 0,
    storage_path:
      typeof row.storage_path === "string" && row.storage_path.trim() !== ""
        ? row.storage_path
        : null,
  };
}

async function signLinePaths(
  supabase: Awaited<ReturnType<typeof createClient>>,
  paths: string[],
): Promise<{ urls: Map<string, string>; error: boolean }> {
  if (paths.length === 0) return { urls: new Map(), error: false };

  const { data, error } = await supabase.storage
    .from("ocr-lines")
    .createSignedUrls(paths, SIGNED_URL_SECONDS);

  if (error) {
    logRpcError("[review_sign_ocr]", error);
    return { urls: new Map(), error: true };
  }

  const urls = new Map<string, string>();
  for (const entry of Array.isArray(data) ? data : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : null;
    const signedUrl =
      typeof record.signedUrl === "string" ? record.signedUrl : null;
    if (path && signedUrl) urls.set(path, signedUrl);
  }

  return { urls, error: false };
}

/**
 * The line images and labels for one OCR page, signed for one hour. The
 * storage policy lets staff sign every line; a missing path or a failed signing
 * call leaves imageUrl null so the reviewer can retry.
 */
export async function getOcrReviewLines(pageId: string): Promise<{
  lines: ReviewOcrLine[];
  imagesError: boolean;
} | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("ocr_lines")
    .select("id, idx, label, width, height, storage_path")
    .eq("page_id", pageId)
    .order("idx", { ascending: true });

  if (error) {
    logRpcError("[review_ocr_lines]", error);
    return null;
  }

  const rows = (Array.isArray(data) ? data : [])
    .map(parseLineRow)
    .filter((row): row is SignedLineRow => row !== null);

  const paths = rows
    .map((row) => row.storage_path)
    .filter((path): path is string => path !== null);

  const signed = await signLinePaths(supabase, paths);
  let imagesError = signed.error;

  const lines: ReviewOcrLine[] = rows.map((row) => {
    const imageUrl = row.storage_path
      ? (signed.urls.get(row.storage_path) ?? null)
      : null;
    if (!imageUrl) imagesError = true;

    return {
      id: row.id,
      idx: row.idx,
      label: row.label,
      width: row.width,
      height: row.height,
      imageUrl,
    };
  });

  return { lines, imagesError };
}

/** Fresh signed URLs for an OCR page, without touching the draft labels. */
export async function refreshOcrReviewImages(pageId: string): Promise<{
  urls: Record<number, string>;
  imagesError: boolean;
} | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("ocr_lines")
    .select("idx, storage_path")
    .eq("page_id", pageId)
    .order("idx", { ascending: true });

  if (error) {
    logRpcError("[review_sign_retry]", error);
    return null;
  }

  const rows = (Array.isArray(data) ? data : [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const idx = Number(row.idx);
      const path = typeof row.storage_path === "string" ? row.storage_path : null;
      if (!Number.isFinite(idx) || !path) return null;
      return { idx: Math.trunc(idx), path };
    })
    .filter(
      (row): row is { idx: number; path: string } => row !== null,
    );

  const signed = await signLinePaths(
    supabase,
    rows.map((row) => row.path),
  );

  const urls: Record<number, string> = {};
  let imagesError = signed.error;
  for (const row of rows) {
    const url = signed.urls.get(row.path);
    if (url) urls[row.idx] = url;
    else imagesError = true;
  }

  return { urls, imagesError };
}

async function loadItem(kind: ReviewKind): Promise<{
  item: ReviewItem | null;
  error: string | null;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("review_next", { p_kind: kind });

  if (error) {
    logRpcError("[review_next]", error);
    return { item: null, error: ITEM_ERROR };
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return { item: null, error: null };

  const item = parseReviewItem(rows[0]);
  if (!item) {
    logRpcError("[review_next]", {
      message: "Unexpected review_next payload",
      code: "REVIEW_PARSE",
    });
    return { item: null, error: ITEM_ERROR };
  }

  if (item.kind === "ocr") {
    const ocr = await getOcrReviewLines(item.id);
    if (!ocr) {
      return { item: { ...item, imagesError: true }, error: null };
    }
    return {
      item: {
        ...item,
        lines: ocr.lines,
        imagesError: ocr.imagesError,
      },
      error: null,
    };
  }

  return { item, error: null };
}

/**
 * One queue: counts for every queue, the oldest reviewable item, the reviewer's
 * counter and the self review setting. A missing item is an honest empty queue,
 * an RPC failure is a separate error state.
 */
export async function getReviewQueue(
  userId: string,
  kind: ReviewKind,
): Promise<ReviewQueue> {
  const [countResult, itemResult, done] = await Promise.all([
    getReviewCounts(),
    loadItem(kind),
    getReviewsDone(userId),
  ]);

  if (!countResult) {
    return { status: "error", kind, message: QUEUE_ERROR };
  }

  if (itemResult.error) {
    return { status: "error", kind, message: itemResult.error };
  }

  return {
    status: "ok",
    kind,
    counts: countResult.counts,
    allowSelfReview: countResult.allowSelfReview,
    reviewsDone: done,
    item: itemResult.item,
  };
}

/** Rejected or reviewer-edited contributions belonging to one contributor. */
export async function getMyFeedback(limit = 10): Promise<FeedbackItem[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_feedback", { p_limit: limit });

  if (error) {
    logRpcError("[feedback]", error);
    return null;
  }

  const parsed = parseFeedbackRows(data);
  if (!parsed) {
    logRpcError("[feedback]", {
      message: "Unexpected my_feedback payload",
      code: "FEEDBACK_PARSE",
    });
    return null;
  }

  return parsed;
}
