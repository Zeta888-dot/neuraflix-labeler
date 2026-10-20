/**
 * Logging for the OCR submit path. Only the error message and code are
 * written. Never keys, tokens, cookies, image data, paths or label text.
 */
export function logOcrSubmitError(error: {
  message?: unknown;
  code?: unknown;
} | null | undefined): void {
  console.error("[ocr_submit]", {
    message:
      typeof error?.message === "string" ? error.message : "Unknown error",
    code: typeof error?.code === "string" ? error.code : null,
  });
}
