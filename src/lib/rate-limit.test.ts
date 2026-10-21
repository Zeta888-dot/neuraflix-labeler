import assert from "node:assert/strict";
import test from "node:test";
import {
  RATE_LIMIT_MESSAGE,
  isExpiredSubmissionError,
  isInvalidTurnsError,
  isRateLimitError,
} from "./rate-limit";

test("rate limit copy matches the brief", () => {
  assert.equal(
    RATE_LIMIT_MESSAGE,
    "You are submitting very quickly. Please wait a little and try again.",
  );
});

test("the exact database token is a rate limit", () => {
  assert.equal(isRateLimitError({ message: "RATE_LIMIT" }), true);
});

test("the token is found inside a wrapped error message", () => {
  assert.equal(
    isRateLimitError({ message: "new row violates check: RATE_LIMIT" }),
    true,
  );
});

test("OCR_RATE_LIMIT is not the submission rate limit", () => {
  assert.equal(isRateLimitError({ message: "OCR_RATE_LIMIT" }), false);
  assert.equal(isRateLimitError({ message: "prefix OCR_RATE_LIMIT" }), false);
});

test("missing errors and messages are not rate limits", () => {
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
  assert.equal(isRateLimitError({}), false);
  assert.equal(isRateLimitError({ message: null }), false);
  assert.equal(isRateLimitError({ message: "" }), false);
});

test("expired and already submitted errors map together", () => {
  assert.equal(isExpiredSubmissionError({ message: "CLAIM_EXPIRED" }), true);
  assert.equal(
    isExpiredSubmissionError({ message: "error: ALREADY_SUBMITTED" }),
    true,
  );
  assert.equal(isExpiredSubmissionError({ message: "RATE_LIMIT" }), false);
  assert.equal(isExpiredSubmissionError(null), false);
});

test("invalid turns is mapped separately", () => {
  assert.equal(
    isInvalidTurnsError({ message: "INVALID_TURNS: turn 2 is empty" }),
    true,
  );
  assert.equal(isInvalidTurnsError({ message: "OTHER" }), false);
  assert.equal(isInvalidTurnsError(undefined), false);
});
