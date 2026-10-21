/**
 * Error mapping for the submission limits enforced by 0009_hardening.sql.
 * Pure functions: imported by server actions and tested in Node without a
 * database or a Supabase client.
 */

export const RATE_LIMIT_MESSAGE =
  "You are submitting very quickly. Please wait a little and try again.";

export type SubmissionErrorFields =
  | { message?: string | null }
  | null
  | undefined;

/**
 * The database raises exactly RATE_LIMIT. OCR raises OCR_RATE_LIMIT, which is a
 * different limit and must not show the submission copy, so match the token
 * boundaries rather than a plain substring.
 */
export function isRateLimitError(error: SubmissionErrorFields): boolean {
  return /\bRATE_LIMIT\b/.test(error?.message ?? "");
}

export function isExpiredSubmissionError(error: SubmissionErrorFields): boolean {
  const message = error?.message ?? "";
  return message.includes("CLAIM_EXPIRED") || message.includes("ALREADY_SUBMITTED");
}

export function isInvalidTurnsError(error: SubmissionErrorFields): boolean {
  return (error?.message ?? "").includes("INVALID_TURNS");
}
