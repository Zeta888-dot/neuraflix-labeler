import {
  lineProgress,
  normalizeLabel,
  validateLabel,
  type LineDraft,
} from "./labels";

/**
 * Pure submit helpers shared by the labeling view, the upload flow and the
 * server action. No DOM, no Supabase and no Node imports, so the same rules
 * run under `npm run test:ocr` and in the browser.
 */

export const MAX_UPLOAD_LINES = 40;
/** 2,000,000 bytes, matching the ocr_lines.bytes check and the bucket cap. */
export const MAX_UPLOAD_BYTES = 2_000_000;

export type UploadPlanLine = {
  /** The original line number in the page list. Never renumbered. */
  idx: number;
  storage_path: string;
  label: string;
};

/**
 * One storage path per line that will actually be uploaded. Unreadable and
 * still-empty lines are left out; the remaining lines keep their original
 * numbers, so deleting line 2 leaves line 3 as idx 3.
 */
export function buildUploadPlan(
  lines: readonly LineDraft[],
  userId: string,
  pageId: string,
  extension: string,
): UploadPlanLine[] {
  const ext = extension.replace(/^\./, "");
  const plan: UploadPlanLine[] = [];

  lines.forEach((line, index) => {
    if (line.status === "unreadable") return;
    const label = normalizeLabel(line.label);
    if (label === "") return;

    const idx = index + 1;
    plan.push({
      idx,
      storage_path: `${userId}/${pageId}/${idx}.${ext}`,
      label,
    });
  });

  return plan;
}

/** WebP when the browser really produced WebP, otherwise JPEG. */
export function pickImageExtension(blobType: string): "webp" | "jpg" {
  return blobType === "image/webp" ? "webp" : "jpg";
}

export type QuotaDecision = "ok" | "warn" | "block";

/**
 * Warn at or above 60 percent after the upload, block above 80 percent.
 * A missing or unusable quota blocks, because uploads cannot be checked.
 */
export function decideQuota(
  usedBytes: number,
  quotaBytes: number,
  incomingBytes: number,
): QuotaDecision {
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return "block";

  const used = Number.isFinite(usedBytes) ? Math.max(0, usedBytes) : 0;
  const incoming = Number.isFinite(incomingBytes)
    ? Math.max(0, incomingBytes)
    : 0;
  const after = used + incoming;

  if (after > quotaBytes * 0.8) return "block";
  if (after >= quotaBytes * 0.6) return "warn";
  return "ok";
}

export type SubmitGate = {
  canSubmit: boolean;
  reason: string | null;
  labeled: number;
  unreadable: number;
  empty: number;
  invalid: number;
};

/**
 * The client gate before the confirm dialog. The server repeats the label
 * checks, and the database repeats the count and ownership checks.
 */
export function submitGate(
  lines: readonly LineDraft[],
  rightsConfirmed: boolean,
): SubmitGate {
  const progress = lineProgress(lines);
  let invalid = 0;

  for (const line of lines) {
    if (line.status === "unreadable") continue;
    if (!validateLabel(line.label).ok) invalid += 1;
  }

  const total = lines.length;
  let reason: string | null = null;

  if (!rightsConfirmed) {
    reason = "Confirm the rights statement before you submit.";
  } else if (total === 0) {
    reason = "There are no lines to submit.";
  } else if (total > MAX_UPLOAD_LINES) {
    reason = "A page can have at most 40 lines.";
  } else if (progress.empty > 0) {
    reason = "Some lines are empty. Write them or mark them unreadable.";
  } else if (progress.labeled === 0) {
    reason = "Add at least one line label before you submit.";
  } else if (invalid > 0) {
    reason =
      "Some labels are too long or contain too many Latin letters. Fix them before you submit.";
  }

  return {
    canSubmit: reason === null,
    reason,
    labeled: progress.labeled,
    unreadable: progress.unreadable,
    empty: progress.empty,
    invalid,
  };
}
