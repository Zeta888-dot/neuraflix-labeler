/**
 * Sync approved OCR line images from the private ocr-lines bucket.
 *
 * Local script only. The default is a dry run:
 *   npm run sync -- [--data path] [--page uuid] [--dry-run]
 *   npm run sync -- --commit [--data path] [--page uuid]
 *
 * --commit downloads missing images into data/ocr/<page_id>/line_<NN>.<ext>,
 * verifies their type, dimensions, byte count and sha256, writes the page
 * manifest and only then marks exported_at. Remote purge is a separate
 * command. Existing images are never overwritten; manifests are merged.
 */
import { resolve } from "node:path";
import { createAdminClient } from "./lib/supabase-admin";
import {
  cleanupTemps,
  displayPath,
  pathExists,
  readJson,
  writeFileNoOverwrite,
  writeJsonAtomic,
} from "./lib/fs-safe";
import {
  localImagePath,
  pageDataDir,
  pageManifestPath,
  readLocalImageFacts,
} from "./lib/local-image";
import {
  buildManifestLine,
  localImageProblem,
  manifestLineProblem,
  mergeSyncManifest,
  parseSyncManifest,
  validateOcrRecord,
  type SyncManifest,
  type SyncManifestLine,
} from "./lib/sync-core";
import { fetchApprovedOcrLines } from "./lib/ocr-query";
import { inspectImage } from "./lib/image-check";
import { extensionForFormat } from "./lib/ocr-paths";

const USAGE =
  "npm run sync -- [--data path] [--page uuid] [--dry-run] | npm run sync -- --commit [--data path] [--page uuid]";

type Options = {
  data: string;
  pageId?: string;
  commit: boolean;
  dryRun: boolean;
};

type PageState = {
  manifest: SyncManifest | null;
  malformed: boolean;
  additions: Map<number, SyncManifestLine>;
  successes: string[];
  failed: boolean;
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

function readPageState(root: string, pageId: string): PageState {
  const manifestPath = pageManifestPath(root, pageId);
  let manifest: SyncManifest | null = null;
  let malformed = false;

  if (pathExists(manifestPath)) {
    const raw = readJson(manifestPath);
    const parsed = raw === null ? null : parseSyncManifest(raw, pageId);
    if (!parsed) {
      malformed = true;
    } else {
      manifest = parsed;
    }
  }

  return {
    manifest,
    malformed,
    additions: new Map(),
    successes: [],
    failed: malformed,
  };
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
    console.log("No approved OCR lines need syncing.");
    return;
  }

  const pages = new Map<string, PageState>();
  const failures: string[] = [];
  let verified = 0;
  let downloaded = 0;
  let missing = 0;
  const alreadyMarked = records.filter((record) => record.exportedAt !== null).length;

  for (const record of records) {
    const check = validateOcrRecord(record);
    if (!check.ok) {
      failures.push(`page ${record.pageId} line ${record.idx}: ${check.reason}`);
      continue;
    }

    let state = pages.get(record.pageId);
    if (!state) {
      if (!options.dryRun) cleanupTemps(pageDataDir(root, record.pageId));
      state = readPageState(root, record.pageId);
      pages.set(record.pageId, state);
    }
    if (state.malformed) {
      failures.push(
        `page ${record.pageId} line ${record.idx}: the sync manifest is unreadable and was left untouched`,
      );
      continue;
    }

    const entry = state.manifest?.lines.find((line) => line.idx === record.idx);
    if (entry) {
      const problem = manifestLineProblem(record, entry);
      if (problem) {
        state.failed = true;
        failures.push(`page ${record.pageId} line ${record.idx}: ${problem}`);
        continue;
      }
    }

    const localPath = localImagePath(root, record);
    if (!localPath) {
      state.failed = true;
      failures.push(`page ${record.pageId} line ${record.idx}: invalid storage path`);
      continue;
    }

    const facts = readLocalImageFacts(localPath);

    if (facts) {
      const problem = localImageProblem(record, entry?.sha256 ?? null, facts);
      if (problem) {
        state.failed = true;
        failures.push(`page ${record.pageId} line ${record.idx}: ${problem}`);
        continue;
      }

      if (!entry) {
        state.additions.set(
          record.idx,
          buildManifestLine(record, check.ext, facts.sha256),
        );
      }
      state.successes.push(record.id);
      verified += 1;
      continue;
    }

    if (pathExists(localPath)) {
      state.failed = true;
      failures.push(
        `page ${record.pageId} line ${record.idx}: the local file is unreadable and was not overwritten`,
      );
      continue;
    }

    missing += 1;
    if (options.dryRun) continue;

    const remotePath = `${check.path.userId}/${check.path.pageId}/${check.path.idx}.${check.ext}`;
    const { data, error } = await supabase.storage
      .from("ocr-lines")
      .download(remotePath);

    if (error || !data) {
      state.failed = true;
      failures.push(`page ${record.pageId} line ${record.idx}: download failed`);
      continue;
    }

    if (data.size !== record.bytes) {
      state.failed = true;
      failures.push(
        `page ${record.pageId} line ${record.idx}: downloaded byte count differs`,
      );
      continue;
    }

    const bytes = new Uint8Array(await data.arrayBuffer());
    const image = inspectImage(bytes);
    if (!image || extensionForFormat(image.format) !== check.ext) {
      state.failed = true;
      failures.push(
        `page ${record.pageId} line ${record.idx}: downloaded image type or header is invalid`,
      );
      continue;
    }
    if (bytes.length !== record.bytes) {
      state.failed = true;
      failures.push(
        `page ${record.pageId} line ${record.idx}: downloaded byte count differs`,
      );
      continue;
    }
    if (image.width !== record.width || image.height !== record.height) {
      state.failed = true;
      failures.push(
        `page ${record.pageId} line ${record.idx}: downloaded dimensions differ`,
      );
      continue;
    }

    try {
      writeFileNoOverwrite(localPath, bytes);
    } catch (writeError) {
      const code = (writeError as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        state.failed = true;
        failures.push(`page ${record.pageId} line ${record.idx}: local write failed`);
        continue;
      }
    }

    const written = readLocalImageFacts(localPath);
    const writtenProblem = written
      ? localImageProblem(record, entry?.sha256 ?? null, written)
      : "the file could not be read after writing";
    if (!written) {
      state.failed = true;
      failures.push(`page ${record.pageId} line ${record.idx}: ${writtenProblem}`);
      continue;
    }
    if (writtenProblem) {
      state.failed = true;
      failures.push(`page ${record.pageId} line ${record.idx}: ${writtenProblem}`);
      continue;
    }

    state.additions.set(
      record.idx,
      buildManifestLine(record, check.ext, written.sha256),
    );
    state.successes.push(record.id);
    downloaded += 1;
  }

  const successfulIds: string[] = [];

  for (const [pageId, state] of pages) {
    if (state.failed && state.successes.length === 0) continue;

    if (state.additions.size > 0 && !options.dryRun) {
      try {
        const merged = mergeSyncManifest(
          state.manifest,
          pageId,
          [...state.additions.values()],
          new Date().toISOString(),
        );
        writeJsonAtomic(pageManifestPath(root, pageId), merged);
      } catch {
        failures.push(`page ${pageId}: the sync manifest could not be written`);
        continue;
      }
    }

    successfulIds.push(...state.successes);
  }

  let marked = 0;
  if (!options.dryRun && successfulIds.length > 0) {
    const unique = [...new Set(successfulIds)];
    for (let from = 0; from < unique.length; from += 100) {
      const batch = unique.slice(from, from + 100);
      const { data: updated, error } = await supabase
        .from("ocr_lines")
        .update({ exported_at: new Date().toISOString() })
        .in("id", batch)
        .is("exported_at", null)
        .select("id");

      if (error) {
        failures.push("Some lines could not be marked as synced");
        break;
      }
      marked += Array.isArray(updated) ? updated.length : 0;
    }
  }

  console.log("");
  console.log(`data directory: ${displayPath(root)}`);
  console.log(`approved OCR lines: ${records.length}`);
  console.log(`verified locally: ${verified}`);
  if (options.dryRun) {
    console.log(`would download: ${missing}`);
  } else {
    console.log(`downloaded: ${downloaded}`);
    console.log(`marked as synced: ${marked}`);
  }
  console.log(`already marked: ${alreadyMarked}`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.length}`);
    for (const failure of failures.slice(0, 12)) console.log(`  ${failure}`);
    if (failures.length > 12) console.log(`  and ${failures.length - 12} more`);
  }
  if (options.dryRun) console.log("dry run: nothing was downloaded or marked");

  if (failures.length > 0) process.exit(1);
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "Sync failed");
});
