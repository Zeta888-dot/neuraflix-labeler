import assert from "node:assert/strict";
import { test } from "node:test";
import {
  memoryByteSource,
  namedHashSource,
  normalizeJsonArrayText,
  normalizeJsonArrayValue,
  PrepareError,
  prepareFile,
  readCsvHeader,
} from "./prepare";

test("normalizeJsonArrayValue accepts arrays, data and rows", () => {
  const rows = [
    { instruction: "a", response: "b" },
    { instruction: "c", response: "d" },
  ];
  const expected = `${JSON.stringify(rows[0])}\n${JSON.stringify(rows[1])}\n`;

  assert.equal(normalizeJsonArrayValue(rows), expected);
  assert.equal(normalizeJsonArrayValue({ data: rows }), expected);
  assert.equal(normalizeJsonArrayValue({ rows }), expected);
  assert.equal(
    normalizeJsonArrayValue({ instruction: "a", response: "b" }),
    `${JSON.stringify({ instruction: "a", response: "b" })}\n`,
  );
});

test("normalizeJsonArrayValue rejects values without rows", () => {
  assert.throws(
    () => normalizeJsonArrayValue({ nope: true }),
    (error: unknown) => {
      assert.ok(error instanceof PrepareError);
      assert.match(error.message, /data or rows array/i);
      return true;
    },
  );
});

test("normalizeJsonArrayText strips a BOM and keeps invalid JSON loud", () => {
  assert.equal(
    normalizeJsonArrayText('\uFEFF[{"instruction":"a","response":"b"}]'),
    '{"instruction":"a","response":"b"}\n',
  );

  assert.throws(() => normalizeJsonArrayText("not json"), SyntaxError);
});

test("readCsvHeader reads the first record and trims a CRLF", async () => {
  const source = memoryByteSource(
    new TextEncoder().encode("instruction,response,input\r\na,b,c\r\n"),
  );

  assert.deepEqual(await readCsvHeader(source), [
    "instruction",
    "response",
    "input",
  ]);
});

test("namedHashSource keeps the name and the source size", async () => {
  const bytes = new TextEncoder().encode("abc");
  const source = memoryByteSource(bytes);
  const named = namedHashSource("file.jsonl", source);

  assert.equal(named.name, "file.jsonl");
  assert.equal(named.size, 3);
  assert.deepEqual(await named.read(0, 2), bytes.slice(0, 2));
});

test("prepareFile reads JSON Lines directly", async () => {
  const text = '{"instruction":"a","response":"b"}\n';
  const file = new File([text], "sample.jsonl", {
    type: "application/x-ndjson",
  });
  const prepared = await prepareFile(file);

  assert.equal(prepared.format, "jsonl");
  assert.equal(prepared.originalName, "sample.jsonl");
  assert.equal(prepared.originalSize, file.size);
  assert.equal(prepared.source.size, file.size);
  assert.equal(prepared.hashSource.name, "sample.jsonl");
  assert.equal(prepared.csvLayout, null);
  assert.equal(prepared.note, null);
});

test("prepareFile converts a JSON array and keeps the original hash size", async () => {
  const text = '[{"instruction":"a","response":"b"}]';
  const file = new File([text], "sample.json");
  const prepared = await prepareFile(file);

  assert.equal(prepared.format, "json");
  assert.equal(prepared.originalSize, file.size);
  assert.equal(prepared.hashSource.size, file.size);
  assert.ok(prepared.source.size > 0);
  assert.match(prepared.note ?? "", /one row per line/i);
});

test("prepareFile falls back to JSON Lines for a .json file with lines", async () => {
  const text =
    '{"instruction":"a","response":"b"}\n{"instruction":"c","response":"d"}\n';
  const file = new File([text], "sample.json");
  const prepared = await prepareFile(file);

  assert.equal(prepared.format, "jsonl");
  assert.equal(prepared.source.size, file.size);
  assert.match(prepared.note ?? "", /JSON Lines/i);
});

test("prepareFile reads a CSV header", async () => {
  const file = new File(["instruction,response\na,b\n"], "sample.csv", {
    type: "text/csv",
  });
  const prepared = await prepareFile(file);

  assert.equal(prepared.format, "csv");
  assert.deepEqual(prepared.csvLayout, {
    instruction: 0,
    response: 1,
    input: null,
    source: null,
  });
});

test("prepareFile rejects an unknown extension and a bad CSV header", async () => {
  await assert.rejects(
    prepareFile(new File(["x"], "sample.txt")),
    (error: unknown) => {
      assert.ok(error instanceof PrepareError);
      return true;
    },
  );

  await assert.rejects(
    prepareFile(new File(["instruction,input\na,b\n"], "sample.csv")),
    (error: unknown) => {
      assert.ok(error instanceof PrepareError);
      assert.match(error.message, /response/i);
      return true;
    },
  );
});
