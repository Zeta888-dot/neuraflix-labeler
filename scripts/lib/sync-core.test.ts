import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManifestLine,
  localImageProblem,
  manifestLineProblem,
  mergeSyncManifest,
  parseSyncManifest,
  purgeProblem,
  validateOcrRecord,
  type LocalImageFacts,
  type OcrLineRecord,
  type SyncManifest,
} from "./sync-core";
import { parseOcrStoragePath, stableOcrId } from "./ocr-paths";

const USER = "11111111-1111-4111-8111-111111111111";
const USER_2 = "55555555-5555-4555-8555-555555555555";
const PAGE = "22222222-2222-4222-8222-222222222222";
const PAGE_2 = "33333333-3333-4333-8333-333333333333";
const LINE = "44444444-4444-4444-8444-444444444444";
const SHA = "a".repeat(64);
const SHA_2 = "b".repeat(64);

function record(overrides: Partial<OcrLineRecord> = {}): OcrLineRecord {
  return {
    id: LINE,
    contributorId: USER,
    pageId: PAGE,
    idx: 3,
    label: "سلام",
    status: "approved",
    pageStatus: "approved",
    storagePath: `${USER}/${PAGE}/3.webp`,
    width: 120,
    height: 40,
    bytes: 2048,
    exportedAt: "2026-10-20T10:00:00.000Z",
    purgedAt: null,
    ...overrides,
  };
}

function facts(overrides: Partial<LocalImageFacts> = {}): LocalImageFacts {
  return {
    format: "webp",
    width: 120,
    height: 40,
    bytes: 2048,
    sha256: SHA,
    ...overrides,
  };
}

function manifestFor(row: OcrLineRecord): SyncManifest {
  return {
    version: 1,
    pageId: row.pageId,
    updatedAt: "2026-10-20T10:00:00.000Z",
    lines: [buildManifestLine(row, "webp", SHA)],
  };
}

test("storage paths are exact and tied to the row", () => {
  assert.deepEqual(
    parseOcrStoragePath(`${USER}/${PAGE}/3.webp`, PAGE, 3),
    { userId: USER, pageId: PAGE, idx: 3, ext: "webp" },
  );
  assert.deepEqual(
    parseOcrStoragePath(`${USER}/${PAGE}/3.WEBP`, PAGE, 3),
    { userId: USER, pageId: PAGE, idx: 3, ext: "webp" },
  );

  const invalid = [
    "../../etc/passwd",
    `${USER}/${PAGE}/0.webp`,
    `${USER}/${PAGE}/41.webp`,
    `${USER}/${PAGE}/03.webp`,
    `${USER}/${PAGE}/3.png`,
    `${USER}/${PAGE}/3.webp/extra`,
    `${USER}/${PAGE_2}/3.webp`,
    ` ${USER}/${PAGE}/3.webp`,
  ];

  for (const path of invalid) {
    assert.equal(parseOcrStoragePath(path, PAGE, 3), null, path);
  }
});

test("approved line and page are both required", () => {
  assert.equal(validateOcrRecord(record()).ok, true);
  assert.equal(validateOcrRecord(record({ status: "rejected" })).ok, false);
  assert.equal(validateOcrRecord(record({ pageStatus: "rejected" })).ok, false);
  assert.equal(
    validateOcrRecord(record({ storagePath: `${USER}/${PAGE_2}/3.webp` })).ok,
    false,
  );
  assert.equal(
    validateOcrRecord(record({ storagePath: `${USER_2}/${PAGE}/3.webp` })).ok,
    false,
  );
  assert.equal(validateOcrRecord(record({ contributorId: null })).ok, false);
  assert.equal(stableOcrId(PAGE, 3), `${PAGE}_03`);
});

test("manifest round trips and rejects duplicates or bad hashes", () => {
  const row = record();
  const manifest = manifestFor(row);

  assert.deepEqual(parseSyncManifest(manifest, PAGE), manifest);
  assert.equal(parseSyncManifest(manifest, PAGE_2), null);
  assert.equal(parseSyncManifest({ ...manifest, version: 2 }, PAGE), null);

  const duplicate = {
    ...manifest,
    lines: [manifest.lines[0], manifest.lines[0]],
  };
  assert.equal(parseSyncManifest(duplicate, PAGE), null);

  const badHash = {
    ...manifest,
    lines: [{ ...manifest.lines[0], sha256: "nope" }],
  };
  assert.equal(parseSyncManifest(badHash, PAGE), null);
});

test("merging a manifest is idempotent and never rewrites a different line", () => {
  const first = record();
  const second = record({
    id: "55555555-5555-4555-8555-555555555555",
    idx: 4,
    storagePath: `${USER}/${PAGE}/4.webp`,
    bytes: 4096,
    height: 50,
  });

  const once = mergeSyncManifest(
    manifestFor(first),
    PAGE,
    [buildManifestLine(second, "webp", SHA_2)],
    "2026-10-20T11:00:00.000Z",
  );
  const twice = mergeSyncManifest(
    once,
    PAGE,
    [buildManifestLine(second, "webp", SHA_2)],
    "2026-10-20T12:00:00.000Z",
  );

  assert.equal(once.lines.length, 2);
  assert.deepEqual(twice.lines, once.lines);

  assert.throws(
    () =>
      mergeSyncManifest(
        once,
        PAGE,
        [buildManifestLine(second, "webp", "c".repeat(64))],
        "2026-10-20T13:00:00.000Z",
      ),
    /changed after it was synced/,
  );
});

test("local image checks cover type, size, dimensions and checksum", () => {
  const row = record();
  assert.equal(localImageProblem(row, SHA, facts()), null);
  assert.match(
    localImageProblem(row, SHA, facts({ format: "jpeg" })) ?? "",
    /type/,
  );
  assert.match(
    localImageProblem(row, SHA, facts({ bytes: 10 })) ?? "",
    /byte count/,
  );
  assert.match(
    localImageProblem(row, SHA, facts({ width: 1 })) ?? "",
    /dimensions/,
  );
  assert.match(
    localImageProblem(row, SHA_2, facts()) ?? "",
    /checksum/,
  );
});

test("purge needs synced, manifest matched and intact local data", () => {
  const row = record();
  const entry = buildManifestLine(row, "webp", SHA);
  const manifest = manifestFor(row);

  assert.equal(purgeProblem(row, entry, facts()), null);
  assert.match(
    purgeProblem(row, entry, null) ?? "",
    /missing or unreadable/,
  );
  assert.match(
    purgeProblem(record({ exportedAt: null }), entry, facts()) ?? "",
    /not marked as synced/,
  );
  assert.match(
    purgeProblem(record({ purgedAt: "2026-10-20T11:00:00.000Z" }), entry, facts()) ?? "",
    /already purged/,
  );
  assert.match(purgeProblem(row, undefined, facts()) ?? "", /no sync manifest/);
  assert.match(
    purgeProblem(row, entry, facts({ sha256: SHA_2 })) ?? "",
    /checksum/,
  );

  assert.equal(manifestLineProblem(row, manifest.lines[0]), null);
  assert.match(
    manifestLineProblem(row, { ...manifest.lines[0], bytes: 1 }) ?? "",
    /byte count/,
  );
});

test("an interrupted sync has no purgeable line", () => {
  const row = record();
  const entry = buildManifestLine(row, "webp", SHA);

  // The manifest survived, but the local file did not: purge must refuse.
  assert.match(purgeProblem(row, entry, null) ?? "", /missing or unreadable/);
});
