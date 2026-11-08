import assert from "node:assert/strict";
import { test } from "node:test";
import { englishHashSource } from "../../khowar";
import { sha256Hex } from "./hash";
import type { RawRow } from "./types";
import {
  buildPreviewRows,
  countDuplicateHashes,
  parseInstructionRaw,
  validateInstructionRow,
} from "./validate";

test("validateInstructionRow trims text and accepts output as response", () => {
  const result = validateInstructionRow(
    { instruction: "  Hello  ", output: "  World  ", input: "  Context  " },
    "file.jsonl",
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.row, {
    instruction: "Hello",
    response: "World",
    input: "Context",
    source: "file.jsonl",
  });
  assert.equal(result.hashSource, englishHashSource("Hello", "Context"));
});

test("validateInstructionRow reports missing and invalid fields", () => {
  const cases: Array<[unknown, string]> = [
    [null, "not_an_object"],
    [[], "not_an_object"],
    [{ response: "b" }, "missing_instruction"],
    [{ instruction: "   ", response: "b" }, "empty_instruction"],
    [{ instruction: "a" }, "missing_response"],
    [{ instruction: "a", response: "   " }, "missing_response"],
    [{ instruction: 1, response: "b" }, "missing_instruction"],
    [{ instruction: "a", response: 1 }, "missing_response"],
    [{ instruction: "a", response: "b", input: 1 }, "invalid_input"],
    [{ instruction: "a", response: "b", source: 1 }, "invalid_source"],
  ];

  for (const [value, reason] of cases) {
    const result = validateInstructionRow(value, null);
    assert.equal(result.ok, false, `expected ${reason}`);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("validateInstructionRow matches the database response fallback", () => {
  const emptyResponse = validateInstructionRow(
    { instruction: "a", response: "", output: "b" },
    null,
  );
  assert.equal(emptyResponse.ok, false);
  if (!emptyResponse.ok) {
    assert.equal(emptyResponse.reason, "missing_response");
  }

  const numericResponse = validateInstructionRow(
    { instruction: "a", response: 1, output: "b" },
    null,
  );
  assert.equal(numericResponse.ok, true);
  if (numericResponse.ok) {
    assert.equal(numericResponse.row.response, "b");
  }
});

test("validateInstructionRow does not limit the file source fallback", () => {
  const result = validateInstructionRow(
    { instruction: "a", response: "b" },
    "x".repeat(121),
  );

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.row.source?.length, 121);
});

test("validateInstructionRow enforces the text limits", () => {
  const long = "x".repeat(20_001);

  const cases: Array<[unknown, string]> = [
    [{ instruction: long, response: "b" }, "instruction_too_long"],
    [{ instruction: "a", response: long }, "response_too_long"],
    [{ instruction: "a", response: "b", input: long }, "input_too_long"],
    [
      { instruction: "a", response: "b", source: "x".repeat(121) },
      "source_too_long",
    ],
  ];

  for (const [value, reason] of cases) {
    const result = validateInstructionRow(value, null);
    assert.equal(result.ok, false, `expected ${reason}`);
    if (!result.ok) assert.equal(result.reason, reason);
  }
});

test("validateInstructionRow ignores extra keys and uses a null input", () => {
  const result = validateInstructionRow(
    {
      instruction: "a",
      response: "b",
      input: null,
      source: null,
      extra: "ignored",
    },
    "fallback",
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.row.input, null);
  assert.equal(result.row.source, "fallback");
  assert.equal(result.hashSource, englishHashSource("a", null));
});

test("parseInstructionRaw reports empty, invalid and non-object rows", () => {
  const empty = parseInstructionRaw("   ", null);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "empty_row");

  const invalid = parseInstructionRaw("not json", null);
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.reason, "invalid_json");
    assert.equal(invalid.detail, "not json");
  }

  const array = parseInstructionRaw("[]", null);
  assert.equal(array.ok, false);
  if (!array.ok) assert.equal(array.reason, "not_an_object");

  const nil = parseInstructionRaw("null", null);
  assert.equal(nil.ok, false);
  if (!nil.ok) assert.equal(nil.reason, "not_an_object");
});

test("parseInstructionRaw rejects a row over 512 KB before parsing", () => {
  const result = parseInstructionRaw("x".repeat(524_289), null);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "row_too_large");
});

test("countDuplicateHashes counts repeats after the first", () => {
  assert.equal(countDuplicateHashes(["a", "a", "b", "a"]), 2);
  assert.equal(countDuplicateHashes([]), 0);
  assert.equal(countDuplicateHashes(["a", "b"]), 0);
});

test("buildPreviewRows marks in-chunk duplicates and invalid rows", async () => {
  const rows: RawRow[] = [
    {
      raw: '{"instruction":"Hello","response":"A"}',
      rowIndex: 1,
      byteLength: 35,
    },
    {
      raw: '{"instruction":"Hello","response":"B"}',
      rowIndex: 2,
      byteLength: 35,
    },
    {
      raw: '{"instruction":"","response":"C"}',
      rowIndex: 3,
      byteLength: 32,
    },
  ];

  const preview = await buildPreviewRows(rows, "file.jsonl");

  assert.equal(preview.validCount, 1);
  assert.equal(preview.duplicateCount, 1);
  assert.equal(preview.invalidCount, 1);
  assert.equal(preview.rows.length, 3);
  assert.equal(preview.errors.length, 1);
  assert.equal(preview.errors[0].rowIndex, 3);
  assert.equal(preview.errors[0].reason, "empty_instruction");

  assert.equal(preview.rows[0].valid, true);
  assert.equal(preview.rows[0].reason, null);
  assert.equal(
    preview.rows[0].hash,
    await sha256Hex(englishHashSource("Hello", null)),
  );

  assert.equal(preview.rows[1].valid, true);
  assert.equal(preview.rows[1].reason, "duplicate_hash");
  assert.equal(preview.rows[2].valid, false);
  assert.equal(preview.rows[2].reason, "empty_instruction");
});
