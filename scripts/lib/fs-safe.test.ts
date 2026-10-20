import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TEMP_PREFIX,
  cleanupTemps,
  pathExists,
  readJson,
  updateLatestLink,
  writeJsonAtomic,
  writeTextNoOverwrite,
} from "./fs-safe";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "labeler-l6-"));
}

test("new files are created but existing files are never overwritten", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "dataset.jsonl");
    writeTextNoOverwrite(file, "first\n");
    assert.equal(readFileSync(file, "utf8"), "first\n");

    assert.throws(
      () => writeTextNoOverwrite(file, "second\n"),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    assert.equal(readFileSync(file, "utf8"), "first\n");
    assert.equal(pathExists(file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed JSON replaces atomically and malformed JSON reads as null", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "manifest.json");
    writeJsonAtomic(file, { version: 1 });
    assert.deepEqual(readJson(file), { version: 1 });

    writeJsonAtomic(file, { version: 2 });
    assert.deepEqual(readJson(file), { version: 2 });

    writeFileSync(join(dir, "broken.json"), "{not json", "utf8");
    assert.equal(readJson(join(dir, "broken.json")), null);
    assert.equal(readJson(join(dir, "missing.json")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only stale temporary files are cleaned up", () => {
  const dir = tempDir();
  try {
    const oldTemp = join(dir, `${TEMP_PREFIX}old`);
    const newTemp = join(dir, `${TEMP_PREFIX}new`);
    const keep = join(dir, "line_01.webp");

    writeFileSync(oldTemp, "old", "utf8");
    writeFileSync(newTemp, "new", "utf8");
    writeFileSync(keep, "image", "utf8");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(oldTemp, twoHoursAgo, twoHoursAgo);

    assert.equal(cleanupTemps(dir), 1);
    assert.equal(pathExists(oldTemp), false);
    assert.equal(pathExists(newTemp), true);
    assert.equal(pathExists(keep), true);
    assert.deepEqual(
      readdirSync(dir).sort(),
      [`${TEMP_PREFIX}new`, "line_01.webp"].sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest is left alone when it is a real directory", () => {
  const dir = tempDir();
  try {
    const root = join(dir, "exports");
    const out = join(root, "20261020T120000Z");
    const latest = join(root, "latest");
    mkdirSync(out, { recursive: true });
    mkdirSync(latest);
    writeFileSync(join(latest, "keep.txt"), "keep", "utf8");

    const result = updateLatestLink(root, out);
    assert.equal(result.status, "blocked");
    assert.equal(pathExists(latest), true);
    assert.equal(readFileSync(join(latest, "keep.txt"), "utf8"), "keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("latest is replaced without touching either export directory", () => {
  const dir = tempDir();
  try {
    const root = join(dir, "exports");
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first, { recursive: true });
    mkdirSync(second);
    writeFileSync(join(first, "first.txt"), "first", "utf8");
    writeFileSync(join(second, "second.txt"), "second", "utf8");

    assert.equal(updateLatestLink(root, first).status, "updated");
    assert.equal(lstatSync(join(root, "latest")).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(join(root, "latest")), ["first.txt"]);

    assert.equal(updateLatestLink(root, second).status, "updated");
    assert.deepEqual(readdirSync(join(root, "latest")), ["second.txt"]);
    assert.equal(pathExists(join(first, "first.txt")), true);
    assert.equal(pathExists(join(second, "second.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
