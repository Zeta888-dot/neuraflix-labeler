import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lineProgress,
  nextEmptyLineIndex,
  nextLineIndex,
  normalizeLabel,
  previousLineIndex,
  statusForLabel,
  validateLabel,
  type LineDraft,
  type LineStatus,
} from "./labels";

function line(
  id: string,
  status: LineStatus,
  label = "",
): LineDraft {
  return { id, box: [0, 0, 10, 10], label, status };
}

test("labels collapse newlines and whitespace into one line", () => {
  assert.equal(normalizeLabel("  الف\n\nدوم  "), "الف دوم");
  assert.equal(normalizeLabel("الف\r\nدوم"), "الف دوم");
  assert.equal(normalizeLabel("a\u0000b"), "ab");
});

test("an empty label is rejected", () => {
  assert.equal(validateLabel("").ok, false);
  assert.equal(validateLabel(" \n\t ").ok, false);
});

test("digits and punctuation are allowed without Arabic letters", () => {
  const result = validateLabel("123 456!");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, "123 456!");
});

test("Latin letters above 20 percent are rejected", () => {
  assert.equal(validateLabel("hello world").ok, false);
  assert.equal(validateLabel("سلامab").ok, false);

  const exactlyTwenty = validateLabel("سلامa");
  assert.equal(exactlyTwenty.ok, true);
});

test("the label limit is 400 characters", () => {
  assert.equal(validateLabel("ا".repeat(400)).ok, true);
  assert.equal(validateLabel("ا".repeat(401)).ok, false);
});

test("status follows the text unless the line is unreadable", () => {
  assert.equal(statusForLabel(""), "empty");
  assert.equal(statusForLabel("  "), "empty");
  assert.equal(statusForLabel("سلام"), "labeled");
});

test("progress counts labeled, unreadable and empty lines", () => {
  const counts = lineProgress([
    line("1", "labeled", "سلام"),
    line("2", "unreadable"),
    line("3", "empty"),
    line("4", "labeled", "دوم"),
    line("5", "unreadable"),
  ]);

  assert.deepEqual(counts, {
    labeled: 2,
    unreadable: 2,
    empty: 1,
    total: 5,
  });

  assert.deepEqual(lineProgress([]), {
    labeled: 0,
    unreadable: 0,
    empty: 0,
    total: 0,
  });
});

test("previous and next clamp at the ends", () => {
  assert.equal(previousLineIndex(0, 4), 0);
  assert.equal(previousLineIndex(2, 4), 1);
  assert.equal(previousLineIndex(3, 4), 2);
  assert.equal(previousLineIndex(0, 0), 0);

  assert.equal(nextLineIndex(0, 4), 1);
  assert.equal(nextLineIndex(2, 4), 3);
  assert.equal(nextLineIndex(3, 4), 3);
  assert.equal(nextLineIndex(0, 0), 0);
});

test("jump to next empty searches forward and wraps once", () => {
  const lines = [
    line("1", "labeled", "سلام"),
    line("2", "empty"),
    line("3", "unreadable"),
    line("4", "empty"),
  ];

  assert.equal(nextEmptyLineIndex(lines, -1), 1);
  assert.equal(nextEmptyLineIndex(lines, 0), 1);
  assert.equal(nextEmptyLineIndex(lines, 1), 3);
  assert.equal(nextEmptyLineIndex(lines, 3), 1);
  assert.equal(
    nextEmptyLineIndex([line("1", "labeled", "سلام")], 0),
    null,
  );
  assert.equal(nextEmptyLineIndex([], 0), null);
});
