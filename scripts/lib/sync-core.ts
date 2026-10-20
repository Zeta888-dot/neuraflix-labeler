import {
  extensionForFormat,
  isUuid,
  localOcrImageFile,
  parseOcrStoragePath,
  type OcrImageExtension,
  type OcrStoragePath,
} from "./ocr-paths";

/**
 * Pure OCR sync and purge rules. The live scripts own Supabase, the file
 * system and logging; every decision about a path, a manifest entry or a local
 * file is made here so it can be tested without network access.
 */

export const SYNC_MANIFEST_VERSION = 1;

export type OcrLineRecord = {
  id: string;
  contributorId: string | null;
  pageId: string;
  idx: number;
  label: string;
  status: string;
  pageStatus: string;
  storagePath: string | null;
  width: number;
  height: number;
  bytes: number;
  exportedAt: string | null;
  purgedAt: string | null;
};

export type OcrRecordCheck =
  | {
      ok: true;
      path: OcrStoragePath;
      ext: OcrImageExtension;
      localFile: string;
    }
  | { ok: false; reason: string };

export type SyncManifestLine = {
  idx: number;
  file: string;
  storagePath: string;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
};

export type SyncManifest = {
  version: typeof SYNC_MANIFEST_VERSION;
  pageId: string;
  updatedAt: string;
  lines: SyncManifestLine[];
};

export type LocalImageFacts = {
  format: "webp" | "jpeg";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
};

const SHA256 = /^[0-9a-f]{64}$/;

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 1) return null;
  return Math.trunc(number);
}

/**
 * A row may be used only when both the line and its page are approved and the
 * storage path matches the row. Callers add the purged_at rule for sync.
 */
export function validateOcrRecord(record: OcrLineRecord): OcrRecordCheck {
  if (record.status !== "approved" || record.pageStatus !== "approved") {
    return { ok: false, reason: "not approved" };
  }
  if (!Number.isInteger(record.idx) || record.idx < 1 || record.idx > 40) {
    return { ok: false, reason: "invalid line number" };
  }

  if (!record.contributorId || !isUuid(record.contributorId)) {
    return { ok: false, reason: "missing page contributor" };
  }

  const path = parseOcrStoragePath(record.storagePath, record.pageId, record.idx);
  if (!path) return { ok: false, reason: "invalid storage path" };
  if (path.userId !== record.contributorId.toLowerCase()) {
    return { ok: false, reason: "storage path owner differs" };
  }

  const width = positiveInteger(record.width);
  const height = positiveInteger(record.height);
  const bytes = positiveInteger(record.bytes);
  if (width === null || height === null || bytes === null) {
    return { ok: false, reason: "invalid image metadata" };
  }

  return {
    ok: true,
    path,
    ext: path.ext,
    localFile: localOcrImageFile(record.idx, path.ext),
  };
}

export function isSyncCandidate(record: OcrLineRecord): boolean {
  return record.purgedAt === null && validateOcrRecord(record).ok;
}

export function buildManifestLine(
  record: OcrLineRecord,
  ext: OcrImageExtension,
  sha256: string,
): SyncManifestLine {
  const check = validateOcrRecord(record);
  if (!check.ok) throw new Error(check.reason);
  if (check.ext !== ext) throw new Error("image extension changed");
  if (!SHA256.test(sha256)) throw new Error("invalid checksum");

  return {
    idx: record.idx,
    file: check.localFile,
    storagePath: check.path.userId + "/" + check.path.pageId + "/" + check.path.idx + "." + ext,
    sha256,
    bytes: record.bytes,
    width: record.width,
    height: record.height,
  };
}

function parseManifestLine(
  value: unknown,
  pageId: string,
): SyncManifestLine | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const idx = positiveInteger(row.idx);
  const bytes = positiveInteger(row.bytes);
  const width = positiveInteger(row.width);
  const height = positiveInteger(row.height);
  const sha256 = typeof row.sha256 === "string" ? row.sha256 : "";
  const file = typeof row.file === "string" ? row.file : "";
  const storagePath =
    typeof row.storagePath === "string" ? row.storagePath : "";

  if (idx === null || idx > 40 || bytes === null || width === null || height === null) {
    return null;
  }
  if (!SHA256.test(sha256)) return null;

  const path = parseOcrStoragePath(storagePath, pageId, idx);
  if (!path) return null;
  if (file !== localOcrImageFile(idx, path.ext)) return null;

  return { idx, file, storagePath, sha256, bytes, width, height };
}

/** Reads a stored page manifest, returning null when it is missing or broken. */
export function parseSyncManifest(
  value: unknown,
  pageId: string,
): SyncManifest | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  if (row.version !== SYNC_MANIFEST_VERSION) return null;
  if (row.pageId !== pageId) return null;
  if (typeof row.updatedAt !== "string" || row.updatedAt === "") return null;
  if (!Array.isArray(row.lines)) return null;

  const lines: SyncManifestLine[] = [];
  const seen = new Set<number>();

  for (const entry of row.lines) {
    const line = parseManifestLine(entry, pageId);
    if (!line || seen.has(line.idx)) return null;
    seen.add(line.idx);
    lines.push(line);
  }

  lines.sort((a, b) => a.idx - b.idx);
  return {
    version: SYNC_MANIFEST_VERSION,
    pageId,
    updatedAt: row.updatedAt,
    lines,
  };
}

export function mergeSyncManifest(
  existing: SyncManifest | null,
  pageId: string,
  additions: SyncManifestLine[],
  updatedAt: string,
): SyncManifest {
  const lines = new Map<number, SyncManifestLine>();
  for (const line of existing?.lines ?? []) lines.set(line.idx, line);

  for (const addition of additions) {
    const current = lines.get(addition.idx);
    if (
      current &&
      (current.storagePath !== addition.storagePath ||
        current.file !== addition.file ||
        current.sha256 !== addition.sha256 ||
        current.bytes !== addition.bytes ||
        current.width !== addition.width ||
        current.height !== addition.height)
    ) {
      throw new Error(
        `line ${addition.idx} changed after it was synced, so the manifest was left untouched`,
      );
    }
    lines.set(addition.idx, addition);
  }

  return {
    version: SYNC_MANIFEST_VERSION,
    pageId,
    updatedAt,
    lines: [...lines.values()].sort((a, b) => a.idx - b.idx),
  };
}

export function manifestLineProblem(
  record: OcrLineRecord,
  entry: SyncManifestLine | undefined,
): string | null {
  if (!entry) return "no sync manifest entry";
  if (entry.idx !== record.idx) return "manifest line number differs";
  if (entry.storagePath !== record.storagePath) return "manifest storage path differs";
  if (entry.bytes !== record.bytes) return "manifest byte count differs";
  if (entry.width !== record.width || entry.height !== record.height) {
    return "manifest dimensions differ";
  }

  const check = validateOcrRecord(record);
  if (!check.ok) return check.reason;
  if (entry.file !== check.localFile) return "manifest file name differs";

  return null;
}

/** Compares the bytes on disk with the database row and the manifest hash. */
export function localImageProblem(
  record: OcrLineRecord,
  expectedSha256: string | null,
  facts: LocalImageFacts,
): string | null {
  const check = validateOcrRecord(record);
  if (!check.ok) return check.reason;

  if (extensionForFormat(facts.format) !== check.ext) {
    return "image type does not match the stored path";
  }
  if (facts.bytes !== record.bytes) return "byte count differs";
  if (facts.width !== record.width || facts.height !== record.height) {
    return "dimensions differ";
  }
  if (expectedSha256 !== null && facts.sha256 !== expectedSha256) {
    return "checksum differs";
  }

  return null;
}

/**
 * The final gate before deleting a remote object. All of these must hold:
 * approved line and page, a finished sync, a matching manifest entry, and a
 * local file with the recorded hash, size and dimensions.
 */
export function purgeProblem(
  record: OcrLineRecord,
  entry: SyncManifestLine | undefined,
  facts: LocalImageFacts | null,
): string | null {
  if (record.purgedAt !== null) return "already purged";
  if (record.exportedAt === null) return "not marked as synced";
  if (!facts) return "local image is missing or unreadable";

  const manifestProblem = manifestLineProblem(record, entry);
  if (manifestProblem) return manifestProblem;

  return localImageProblem(record, entry?.sha256 ?? null, facts);
}
