import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildErrorCsv,
  csvCell,
  csvRecordToRaw,
  CsvError,
  findCsvRecord,
  parseCsvHeader,
  parseCsvRecord,
} from "./csv";

test("parseCsvRecord handles quoted commas and escaped quotes", () => {
  assert.deepEqual(parseCsvRecord('"a,b","c""d",e'), ["a,b", 'c"d', "e"]);
  assert.deepEqual(parseCsvRecord("plain,fields"), ["plain", "fields"]);
});

test("parseCsvRecord keeps a newline inside a quoted field", () => {
  assert.deepEqual(parseCsvRecord('"line one\nline two",ok'), [
    "line one\nline two",
    "ok",
  ]);
});

test("findCsvRecord ignores newlines inside quotes", () => {
  const bytes = new TextEncoder().encode('"a\nb",c\nnext\n');
  const first = findCsvRecord(bytes, 0);

  assert.equal(first.contentStart, 0);
  assert.equal(first.contentEnd, 7);
  assert.equal(first.next, 8);

  const second = findCsvRecord(bytes, first.next);
  assert.equal(second.contentStart, 8);
  assert.equal(second.contentEnd, 12);
  assert.equal(second.next, 13);
});

test("parseCsvHeader accepts instruction with response or output", () => {
  assert.deepEqual(parseCsvHeader(["instruction", "response"]), {
    instruction: 0,
    response: 1,
    input: null,
    source: null,
  });

  assert.deepEqual(
    parseCsvHeader(["\uFEFFInstruction", "Output", "Input", "Source"]),
    {
      instruction: 0,
      response: 1,
      input: 2,
      source: 3,
    },
  );
});

test("parseCsvHeader rejects a missing required column", () => {
  assert.throws(
    () => parseCsvHeader(["instruction", "input"]),
    (error: unknown) => {
      assert.ok(error instanceof CsvError);
      assert.match(error.message, /response \(or output\)/i);
      return true;
    },
  );
});

test("csvRecordToRaw trims fields and leaves empty fields out", () => {
  const layout = parseCsvHeader([
    "instruction",
    "response",
    "input",
    "source",
  ]);

  assert.deepEqual(
    JSON.parse(
      csvRecordToRaw('"Say ""hi""","Hello, friend", x , y ', layout),
    ),
    {
      instruction: 'Say "hi"',
      response: "Hello, friend",
      input: "x",
      source: "y",
    },
  );

  assert.deepEqual(JSON.parse(csvRecordToRaw(",", layout)), {});
});

test("csvCell neutralises spreadsheet formula prefixes", () => {
  assert.equal(csvCell("=1+1"), "\"'=1+1\"");
  assert.equal(csvCell("+1"), "\"'+1\"");
  assert.equal(csvCell("-1"), "\"'-1\"");
  assert.equal(csvCell("@x"), "\"'@x\"");
  assert.equal(csvCell("normal"), "\"normal\"");
  assert.equal(csvCell('a"b'), "\"a\"\"b\"");
});

test("buildErrorCsv quotes every cell and sanitises details", () => {
  const csv = buildErrorCsv([
    { rowIndex: 1, reason: "invalid_json", detail: "=cmd" },
    { rowIndex: 2, reason: "duplicate_hash", detail: null },
  ]);

  assert.equal(
    csv,
    'row_index,reason,detail\r\n"1","invalid_json","\'=cmd"\r\n"2","duplicate_hash",""\r\n',
  );
});
