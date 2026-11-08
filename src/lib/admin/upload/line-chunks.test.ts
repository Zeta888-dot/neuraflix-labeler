import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCsvHeader } from "./csv";
import {
  ChunkReadError,
  readChunk,
  readCsvChunk,
  readJsonlChunk,
  RowTooLargeError,
} from "./line-chunks";
import { memoryByteSource } from "./prepare";

function sourceFromText(text: string) {
  return memoryByteSource(new TextEncoder().encode(text));
}

test("JSONL reader stops at row limits and resumes at the byte offset", async () => {
  const text =
    '{"instruction":"a","response":"b"}\r\n\r\n{"instruction":"c","response":"d"}\n';
  const source = sourceFromText(text);

  const first = await readJsonlChunk(source, 0, 0, {
    chunkRows: 1,
    maxBytes: 700_000,
  });

  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].raw, '{"instruction":"a","response":"b"}');
  assert.equal(first.rows[0].rowIndex, 1);
  assert.equal(first.startOffset, 0);
  assert.equal(first.endOffset, text.indexOf("\n") + 1);
  assert.equal(first.nextRow, 1);
  assert.equal(first.done, false);

  const second = await readJsonlChunk(
    source,
    first.endOffset,
    first.nextRow,
    { chunkRows: 1, maxBytes: 700_000 },
  );

  assert.equal(second.rows.length, 1);
  assert.equal(second.rows[0].raw, '{"instruction":"c","response":"d"}');
  assert.equal(second.rows[0].rowIndex, 2);
  assert.equal(second.nextRow, 2);
  assert.equal(second.done, true);
  assert.equal(second.endOffset, source.size);

  const empty = await readJsonlChunk(source, source.size, 2, {
    chunkRows: 1,
    maxBytes: 700_000,
  });
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.done, true);
  assert.equal(empty.endOffset, source.size);
});

test("JSONL reader keeps multibyte rows and strips a first BOM", async () => {
  const row = '{"instruction":"سلام","response":"خوب"}';
  const source = sourceFromText(`\uFEFF${row}\n`);
  const chunk = await readJsonlChunk(source, 0, 0, {
    chunkRows: 10,
    maxBytes: 700_000,
  });

  assert.equal(chunk.rows.length, 1);
  assert.equal(chunk.rows[0].raw, row);
  assert.equal(
    chunk.rows[0].byteLength,
    new TextEncoder().encode(`\uFEFF${row}`).length,
  );
  assert.equal(
    new TextEncoder().encode(chunk.rows[0].raw).length,
    new TextEncoder().encode(row).length,
  );
});

test("JSONL reader caps a chunk at 200 rows by default", async () => {
  const lines = Array.from({ length: 250 }, (_, index) =>
    JSON.stringify({ instruction: `i${index}`, response: "r" }),
  );
  const source = sourceFromText(`${lines.join("\n")}\n`);

  const first = await readJsonlChunk(source, 0, 0, {
    chunkRows: 200,
    maxBytes: 700_000,
  });
  assert.equal(first.rows.length, 200);
  assert.equal(first.rows[0].rowIndex, 1);
  assert.equal(first.rows[199].rowIndex, 200);
  assert.equal(first.done, false);

  const second = await readJsonlChunk(
    source,
    first.endOffset,
    first.nextRow,
    { chunkRows: 200, maxBytes: 700_000 },
  );
  assert.equal(second.rows.length, 50);
  assert.equal(second.rows[0].rowIndex, 201);
  assert.equal(second.rows[49].rowIndex, 250);
  assert.equal(second.done, true);
});

test("JSONL reader stops before a row that would pass the byte cap", async () => {
  const row = JSON.stringify({
    instruction: "x".repeat(80),
    response: "y",
  });
  const rowBytes = new TextEncoder().encode(row).length;
  const source = sourceFromText(
    `${Array.from({ length: 5 }, () => row).join("\n")}\n`,
  );

  const first = await readJsonlChunk(source, 0, 0, {
    chunkRows: 1000,
    maxBytes: rowBytes * 2,
  });

  assert.equal(first.rows.length, 2);
  assert.equal(first.done, false);

  const second = await readJsonlChunk(
    source,
    first.endOffset,
    first.nextRow,
    { chunkRows: 1000, maxBytes: rowBytes * 2 },
  );
  assert.equal(second.rows.length, 2);
  assert.equal(second.done, false);
});

test("JSONL reader refuses a first row larger than the byte cap", async () => {
  const source = sourceFromText(
    '{"instruction":"this row is too large","response":"x"}\n',
  );

  await assert.rejects(
    readJsonlChunk(source, 0, 0, { chunkRows: 10, maxBytes: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof RowTooLargeError);
      assert.match(error.message, /larger than the chunk limit/i);
      return true;
    },
  );
});

test("CSV reader handles quoted commas, quoted newlines and CRLF", async () => {
  const csv =
    'instruction,response,input\r\n"Say ""hello""","Hello, friend",\r\n"Line one\nline two",ok,extra\r\n';
  const source = sourceFromText(csv);
  const layout = parseCsvHeader(["instruction", "response", "input"]);

  const first = await readCsvChunk(source, layout, 0, 0, {
    chunkRows: 1,
    maxBytes: 700_000,
  });

  assert.equal(first.rows.length, 1);
  assert.deepEqual(JSON.parse(first.rows[0].raw), {
    instruction: 'Say "hello"',
    response: "Hello, friend",
  });
  assert.equal(first.rows[0].rowIndex, 1);
  assert.equal(first.done, false);

  const second = await readCsvChunk(
    source,
    layout,
    first.endOffset,
    first.nextRow,
    { chunkRows: 1, maxBytes: 700_000 },
  );

  assert.equal(second.rows.length, 1);
  assert.deepEqual(JSON.parse(second.rows[0].raw), {
    instruction: "Line one\nline two",
    response: "ok",
    input: "extra",
  });
  assert.equal(second.rows[0].rowIndex, 2);
  assert.equal(second.done, true);
  assert.equal(second.endOffset, source.size);
});

test("CSV reader returns an empty done chunk for a header only file", async () => {
  const source = sourceFromText("instruction,response\n");
  const layout = parseCsvHeader(["instruction", "response"]);

  const chunk = await readCsvChunk(source, layout, 0, 0, {
    chunkRows: 200,
    maxBytes: 700_000,
  });

  assert.equal(chunk.rows.length, 0);
  assert.equal(chunk.done, true);
  assert.equal(chunk.endOffset, source.size);
});

test("readChunk dispatches CSV and JSONL and rejects a missing layout", async () => {
  const csv = sourceFromText("instruction,response\na,b\n");
  const layout = parseCsvHeader(["instruction", "response"]);

  const csvChunk = await readChunk(csv, "csv", layout, 0, 0, {
    chunkRows: 10,
    maxBytes: 700_000,
  });
  assert.equal(csvChunk.rows.length, 1);

  await assert.rejects(
    readChunk(csv, "csv", null, 0, 0, {
      chunkRows: 10,
      maxBytes: 700_000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChunkReadError);
      return true;
    },
  );

  const jsonl = sourceFromText('{"instruction":"a","response":"b"}\n');
  const jsonlChunk = await readChunk(jsonl, "json", null, 0, 0, {
    chunkRows: 10,
    maxBytes: 700_000,
  });
  assert.equal(jsonlChunk.rows.length, 1);
});
