import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChunkResult, parseImportSource } from "./parse";

const sourceId = "11111111-1111-4111-8111-111111111111";
const batchId = "22222222-2222-4222-8222-222222222222";

const createPayload = {
  source_id: sourceId,
  batch_id: batchId,
  kind: "instruction",
  file_name: "test-instructions.jsonl",
  file_size: 2048,
  file_hash: "a".repeat(64),
  source_label: "test",
  target_count: 1,
  chunk_size: 200,
  status: "active",
  next_offset: 0,
  next_row: 0,
  next_chunk_index: 0,
  loaded_rows: 0,
  skipped_rows: 0,
  invalid_rows: 0,
  resumed: false,
  last_chunk_index: null,
  last_chunk_start: null,
  last_chunk_end: null,
  last_chunk_hash: null,
};

test("parseImportSource accepts the source_id column from create", () => {
  const source = parseImportSource(createPayload);

  assert.ok(source);
  assert.equal(source.id, sourceId);
  assert.equal(source.batchId, batchId);
  assert.equal(source.kind, "instruction");
  assert.equal(source.status, "active");
  assert.equal(source.nextOffset, 0);
  assert.equal(source.resumed, false);
});

test("parseImportSource still accepts the id column from list", () => {
  const source = parseImportSource({
    ...createPayload,
    id: sourceId,
    source_id: undefined,
  });

  assert.ok(source);
  assert.equal(source.id, sourceId);
});

test("parseImportSource prefers id and rejects rows without one", () => {
  const preferred = parseImportSource({ ...createPayload, id: batchId });
  assert.ok(preferred);
  assert.equal(preferred.id, batchId);

  assert.equal(
    parseImportSource({ ...createPayload, source_id: undefined }),
    null,
  );
});

test("parseChunkResult reads the counters and invalid rows from 0010", () => {
  const result = parseChunkResult({
    loaded_rows: 7,
    skipped_rows: 1,
    invalid_rows: 2,
    next_offset: 4096,
    next_row: 10,
    status: "completed",
    already_committed: false,
    errors: [
      {
        row_index: 8,
        reason: "duplicate_hash",
        detail: null,
        created_at: null,
      },
      {
        row_index: 9,
        reason: "missing_response",
        detail: null,
        created_at: null,
      },
    ],
  });

  assert.ok(result);
  assert.equal(result.loadedRows, 7);
  assert.equal(result.skippedRows, 1);
  assert.equal(result.invalidRows, 2);
  assert.equal(result.nextOffset, 4096);
  assert.equal(result.nextRow, 10);
  assert.equal(result.status, "completed");
  assert.equal(result.alreadyCommitted, false);
  assert.deepEqual(
    result.errors.map((row) => row.rowIndex),
    [8, 9],
  );
});

test("parseChunkResult rejects a payload without progress fields", () => {
  assert.equal(parseChunkResult({ loaded_rows: 7 }), null);
});
