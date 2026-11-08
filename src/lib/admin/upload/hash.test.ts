import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  HASH_BLOCK_BYTES,
  HASH_PREFIX,
  assertResumeAnchor,
  hashFile,
  ResumeMismatchError,
  sha256Hex,
  type HashSource,
} from "./hash";

function sourceFromBytes(name: string, bytes: Uint8Array): HashSource {
  return {
    name,
    size: bytes.length,
    read(start: number, end: number): Promise<Uint8Array> {
      return Promise.resolve(bytes.slice(start, end));
    },
  };
}

function manualChain(name: string, bytes: Uint8Array): string {
  let digest = createHash("sha256")
    .update(`${HASH_PREFIX}${name}\n${bytes.length}`)
    .digest();

  for (let offset = 0; offset < bytes.length; offset += HASH_BLOCK_BYTES) {
    const block = bytes.subarray(
      offset,
      Math.min(offset + HASH_BLOCK_BYTES, bytes.length),
    );
    digest = createHash("sha256").update(digest).update(block).digest();
  }

  return digest.toString("hex");
}

test("sha256Hex matches Node for ASCII and Unicode", async () => {
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  const text = "سلام hello";
  assert.equal(
    await sha256Hex(text),
    createHash("sha256").update(text, "utf8").digest("hex"),
  );
});

test("hashFile chains blocks and reports progress", async () => {
  const bytes = new Uint8Array(HASH_BLOCK_BYTES + 12345);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }

  const progress: number[] = [];
  const hash = await hashFile(sourceFromBytes("sample.jsonl", bytes), (done) => {
    progress.push(done);
  });

  assert.equal(hash, manualChain("sample.jsonl", bytes));
  assert.deepEqual(progress, [HASH_BLOCK_BYTES, bytes.length]);
});

test("hashFile is deterministic and changes with the name or bytes", async () => {
  const bytes = new TextEncoder().encode("same bytes");
  const first = await hashFile(sourceFromBytes("a.jsonl", bytes));
  const second = await hashFile(sourceFromBytes("a.jsonl", bytes));
  const renamed = await hashFile(sourceFromBytes("b.jsonl", bytes));
  const changedBytes = new TextEncoder().encode("same bytez");
  const changed = await hashFile(sourceFromBytes("a.jsonl", changedBytes));

  assert.equal(first, second);
  assert.notEqual(first, renamed);
  assert.notEqual(first, changed);
});

test("assertResumeAnchor accepts a match and stops on a mismatch", () => {
  assert.doesNotThrow(() => assertResumeAnchor("abc", "ABC"));

  assert.throws(
    () => assertResumeAnchor("abc", "def"),
    (error: unknown) => {
      assert.ok(error instanceof ResumeMismatchError);
      assert.match(error.message, /cannot resume/i);
      return true;
    },
  );
});
