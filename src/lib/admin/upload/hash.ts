/**
 * Browser hashing for the text import.
 *
 * The whole-file hash is a chained SHA-256. It never loads the whole file:
 *   h0 = SHA-256("neuraflix-upload-v1\n" + name + "\n" + size)
 *   hn = SHA-256(hn-1 bytes || block bytes)
 * The final hex value identifies the file. A chunk hash is a plain SHA-256 of
 * the exact bytes in one committed slice.
 */

export const HASH_BLOCK_BYTES = 1024 * 1024;
export const HASH_PREFIX = "neuraflix-upload-v1\n";

export type ByteSource = {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
};

export type HashSource = {
  name: string;
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
};

export function toHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
}

export async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return new Uint8Array(digest);
}

export async function sha256Hex(
  value: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return toHex(await sha256Bytes(bytes));
}

/**
 * Chained file hash. `onProgress` receives bytes read and total bytes after
 * every block. The source is read in 1 MiB blocks, so memory stays bounded.
 */
export async function hashFile(
  source: HashSource,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const header = new TextEncoder().encode(
    `${HASH_PREFIX}${source.name}\n${source.size}`,
  );
  let digest = await sha256Bytes(header);

  for (let offset = 0; offset < source.size; offset += HASH_BLOCK_BYTES) {
    const end = Math.min(offset + HASH_BLOCK_BYTES, source.size);
    const block = await source.read(offset, end);
    const combined = new Uint8Array(digest.length + block.length);
    combined.set(digest, 0);
    combined.set(block, digest.length);
    digest = await sha256Bytes(combined);
    onProgress?.(end, source.size);
  }

  return toHex(digest);
}

export class ResumeMismatchError extends Error {
  constructor() {
    super(
      "This file changed at the last saved chunk. It cannot resume. Select the original file or start a new import.",
    );
    this.name = "ResumeMismatchError";
  }
}

/**
 * Compares the hash the browser just computed for the last committed slice
 * with the hash the database stored. A mismatch means the file changed after
 * the last chunk. The caller must stop and show ResumeMismatchError.
 */
export function assertResumeAnchor(
  expected: string,
  actual: string,
): void {
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new ResumeMismatchError();
  }
}
