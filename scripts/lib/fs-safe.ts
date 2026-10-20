import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * Local file helpers for the L6 scripts. Every write either creates a brand new
 * file with a hard link or replaces a managed manifest atomically. Existing
 * images and export files are never overwritten silently.
 */

export const TEMP_PREFIX = ".labeler-tmp-";

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function readBytes(path: string): Buffer {
  return readFileSync(path);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeTemp(dir: string, bytes: Uint8Array): string {
  ensureDir(dir);
  const temp = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }
  closeSync(fd);
  return temp;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best effort cleanup only.
  }
}

/**
 * Creates `path` only when it does not exist. The data is written and fsynced to
 * a temporary name first, then hard linked into place. link() is atomic and
 * fails with EEXIST instead of replacing an existing file.
 */
export function writeFileNoOverwrite(
  path: string,
  bytes: Uint8Array,
): void {
  const dir = dirname(path);
  ensureDir(dir);
  const temp = writeTemp(dir, bytes);

  try {
    linkSync(temp, path);
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }

  removeQuietly(temp);
}

export function writeTextNoOverwrite(path: string, text: string): void {
  writeFileNoOverwrite(path, Buffer.from(text, "utf8"));
}

/** Replaces a script owned JSON file atomically. Used only for sync manifests. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const dir = dirname(path);
  const temp = writeTemp(dir, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));

  try {
    renameSync(temp, path);
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Removes orphaned temporary files older than one hour. */
export function cleanupTemps(dir: string): number {
  let removed = 0;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const path = join(dir, name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      // Ignore a file another process already cleaned up.
    }
  }

  return removed;
}

export type LatestLinkResult =
  | { status: "updated" }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Replaces exports/latest only when it is already a link. A real directory or
 * file is never removed or overwritten.
 */
export function updateLatestLink(
  exportsRoot: string,
  outDir: string,
): LatestLinkResult {
  const latest = join(exportsRoot, "latest");

  try {
    const stats = lstatSync(latest);
    if (!stats.isSymbolicLink()) {
      return {
        status: "blocked",
        reason: "exports/latest exists and is not a link, so it was left untouched",
      };
    }
    unlinkSync(latest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { status: "failed", reason: "the old latest link could not be removed" };
    }
  }

  try {
    if (process.platform === "win32") {
      symlinkSync(resolve(outDir), latest, "junction");
    } else {
      const target = relative(resolve(exportsRoot), resolve(outDir));
      symlinkSync(target, latest, "dir");
    }
    return { status: "updated" };
  } catch {
    return {
      status: "failed",
      reason: "the latest link could not be created",
    };
  }
}

/** Only used to keep a clear path in output messages, never for security. */
export function displayPath(path: string): string {
  return basename(path) === path ? path : relative(process.cwd(), path) || path;
}
