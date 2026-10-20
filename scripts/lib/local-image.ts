import { join } from "node:path";
import { readBytes, readJson, sha256Hex } from "./fs-safe";
import { inspectImage } from "./image-check";
import { localOcrImageFile } from "./ocr-paths";
import {
  parseSyncManifest,
  validateOcrRecord,
  type LocalImageFacts,
  type OcrLineRecord,
  type SyncManifest,
} from "./sync-core";

export function pageDataDir(root: string, pageId: string): string {
  return join(root, pageId);
}

export function pageManifestPath(root: string, pageId: string): string {
  return join(pageDataDir(root, pageId), "manifest.json");
}

export function localImagePath(root: string, record: OcrLineRecord): string | null {
  const check = validateOcrRecord(record);
  if (!check.ok) return null;
  return join(pageDataDir(root, record.pageId), check.localFile);
}

export function readPageManifest(
  root: string,
  pageId: string,
): SyncManifest | null {
  return parseSyncManifest(
    readJson(pageManifestPath(root, pageId)),
    pageId,
  );
}

/**
 * Reads and hashes one local line image. Returns null when the file is
 * missing, empty, unreadable or not a valid WebP or JPEG.
 */
export function readLocalImageFacts(path: string): LocalImageFacts | null {
  try {
    const bytes = readBytes(path);
    if (bytes.length === 0) return null;
    const image = inspectImage(bytes);
    if (!image) return null;
    return {
      format: image.format,
      width: image.width,
      height: image.height,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
    };
  } catch {
    return null;
  }
}

export function expectedLocalFile(record: OcrLineRecord): string | null {
  const check = validateOcrRecord(record);
  if (!check.ok) return null;
  return localOcrImageFile(record.idx, check.ext);
}
