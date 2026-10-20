/**
 * Purge approved OCR line images from the private ocr-lines bucket.
 *
 * Local script only. Purging is a separate, explicit operation and is never a
 * side effect of export or sync:
 *   npm run purge:ocr                          (dry run, the default)
 *   npm run purge:ocr -- --commit              (delete after local checks)
 *   npm run purge:ocr -- --commit --page uuid
 *
 * Before every delete the script requires: approved line and page, exported_at
 * set, a valid sync manifest entry, and a local file whose type, dimensions,
 * byte count and sha256 match the record. A failed check leaves the remote
 * object untouched. The local image is never deleted.
 */
import { resolve } from "node:path";
import { createAdminClient } from "./lib/supabase-admin";
import { displayPath, pathExists, readJson } from "./lib/fs-safe";
import {
  localImagePath,
  pageManifestPath,
  readLocalImageFacts,
} from "./lib/local-image";
import { fetchApprovedOcrLines } from "./lib/ocr-query";
import {
  parseSyncManifest,
  purgeProblem,
  validateOcrRecord,
} from "./lib/sync-core";
import type { SyncManifest } from "./lib/sync-core";

const USAGE =
  "npm run purge:ocr [--data path] [--page uuid] [--dry-run] | npm run purge:ocr -- --commit [--data path] [--page uuid]";

type Options = {
  data: string;
  pageId?: string;
  commit: boolean;
  dryRun: boolean;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseOptions(argv: string[]): Options {
  let data = "data/ocr";
  let pageId: string | undefined;
  let commit = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === "--commit") {
      commit = true;
      continue;
    }
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (flag === "--data" || flag === "--page") {
      if (next === undefined || next.startsWith("--")) {
        fail(`${flag} needs a value.\n${USAGE}`);
      }
      index += 1;
      if (flag === "--data") data = next;
      if (flag === "--page") pageId = next;
      continue;
    }

    fail(`Unknown argument: ${flag}\n${USAGE}`);
  }

  if (commit && dryRun) fail(`Use --commit or --dry-run, not both.\n${USAGE}`);
  return { data, pageId, commit, dryRun: dryRun || !commit };
}

type ManifestState = { manifest: SyncManifest | null; malformed: boolean };

function readManifestState(root: string, pageId: string): ManifestState {
  const path = pageManifestPath(root, pageId);
  if (!pathExists(path)) return { manifest: null, malformed: false };

  const parsed = parseSyncManifest(readJson(path), pageId);
  if (!parsed) return { manifest: null, malformed: true };
  return { manifest: parsed, malformed: false };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const root = resolve(options.data);

  const supabase = createAdminClient();
  const records = await fetchApprovedOcrLines(supabase, {
    includePurged: false,
    pageId: options.pageId,
  });

  if (records.length === 0) {
    console.log("No approved OCR files are waiting to be purged.");
    return;
  }

  const manifests = new Map<string, ManifestState>();
  const failures: string[] = [];
  let ready = 0;
  let readyBytes = 0;
  let purged = 0;

  for (const record of records) {
    const check = validateOcrRecord(record);
    if (!check.ok) {
      failures.push(`page ${record.pageId} line ${record.idx}: ${check.reason}`);
      continue;
    }

    if (!manifests.has(record.pageId)) {
      manifests.set(record.pageId, readManifestState(root, record.pageId));
    }
    const state = manifests.get(record.pageId);
    if (!state || state.malformed) {
      failures.push(
        `page ${record.pageId} line ${record.idx}: the sync manifest is unreadable`,
      );
      continue;
    }

    const entry = state.manifest?.lines.find((line) => line.idx === record.idx);
    const path = localImagePath(root, record);
    const facts = path ? readLocalImageFacts(path) : null;
    const problem = purgeProblem(record, entry, facts);

    if (problem) {
      failures.push(`page ${record.pageId} line ${record.idx}: ${problem}`);
      continue;
    }

    ready += 1;
    readyBytes += record.bytes;
    if (options.dryRun) continue;

    const remotePath = `${check.path.userId}/${check.path.pageId}/${check.path.idx}.${check.ext}`;
    const { error: removeError } = await supabase.storage
      .from("ocr-lines")
      .remove([remotePath]);

    if (removeError) {
      failures.push(
        `page ${record.pageId} line ${record.idx}: the remote object could not be deleted`,
      );
      continue;
    }

    const { data: updated, error: updateError } = await supabase
      .from("ocr_lines")
      .update({ purged_at: new Date().toISOString() })
      .eq("id", record.id)
      .is("purged_at", null)
      .select("id");

    if (updateError) {
      failures.push(
        `page ${record.pageId} line ${record.idx}: the remote object was deleted but purged_at could not be set; run purge again to recover`,
      );
      continue;
    }

    purged += Array.isArray(updated) ? updated.length : 0;
  }

  console.log("");
  console.log(`data directory: ${displayPath(root)}`);
  console.log(`approved OCR lines: ${records.length}`);
  console.log(`ready to purge: ${ready}`);
  console.log(`bytes ready: ${readyBytes}`);
  if (options.dryRun) {
    console.log("dry run: no remote files were deleted");
  } else {
    console.log(`purged: ${purged}`);
  }
  if (failures.length > 0) {
    console.log(`failed: ${failures.length}`);
    for (const failure of failures.slice(0, 12)) console.log(`  ${failure}`);
    if (failures.length > 12) console.log(`  and ${failures.length - 12} more`);
  }

  if (failures.length > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Purge failed");
});
