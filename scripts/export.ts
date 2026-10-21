/**
 * Export approved instruction, conversation, plain text and OCR data.
 *
 * Local script only. Run through the npm script so .env.local is loaded:
 *   npm run export -- [--out path] [--data path] [--dry-run] [--no-latest]
 *
 * Only status = approved rows are read. OCR lines also require an approved
 * page. OCR images come from the verified local sync store, never from the
 * full page image and never from a remote file name.
 */
import { mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createAdminClient } from "./lib/supabase-admin";
import {
  EXPORT_SCHEMA_VERSION,
  OCR_PROMPT,
  VAL_RATIO,
  buildCharset,
  buildExportData,
  contributorsCsv,
  datasetNotes,
  ocrJsonl,
  ocrText,
  toJsonl,
  type ExportBuild,
  type OcrExportLine,
} from "./lib/export-core";
import { fetchExportInput } from "./lib/export-data";
import {
  displayPath,
  ensureDir,
  readBytes,
  sha256Hex,
  updateLatestLink,
  writeFileNoOverwrite,
  writeJsonAtomic,
  writeTextNoOverwrite,
} from "./lib/fs-safe";
import {
  expectedLocalFile,
  pageDataDir,
  readLocalImageFacts,
  readPageManifest,
} from "./lib/local-image";
import {
  localImageProblem,
  manifestLineProblem,
  type LocalImageFacts,
  type OcrLineRecord,
} from "./lib/sync-core";

const USAGE =
  "npm run export -- [--out path] [--data path] [--dry-run] [--no-latest]";

type Options = {
  out: string | null;
  data: string;
  dryRun: boolean;
  latest: boolean;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseOptions(argv: string[]): Options {
  let out: string | null = null;
  let data = "data/ocr";
  let dryRun = false;
  let latest = true;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--no-latest") {
      latest = false;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (flag === "--out" || flag === "--data") {
      if (next === undefined || next.startsWith("--")) {
        fail(`${flag} needs a value.\n${USAGE}`);
      }
      index += 1;
      if (flag === "--out") out = next;
      if (flag === "--data") data = next;
      continue;
    }

    fail(`Unknown argument: ${flag}\n${USAGE}`);
  }

  return { out, data, dryRun, latest };
}

function timestampDir(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join("exports", stamp);
}

function asRecord(row: OcrExportLine): OcrLineRecord {
  return {
    id: row.lineId,
    contributorId: row.contributorId,
    pageId: row.pageId,
    idx: row.idx,
    label: row.label,
    status: "approved",
    pageStatus: "approved",
    storagePath: row.storagePath,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    exportedAt: null,
    purgedAt: null,
  };
}

type OcrPreflight = {
  facts: Map<string, { path: string; facts: LocalImageFacts }>;
};

function preflightOcr(rows: OcrExportLine[], dataRoot: string): OcrPreflight {
  const facts = new Map<string, { path: string; facts: LocalImageFacts }>();
  const manifestCache = new Map<string, ReturnType<typeof readPageManifest>>();
  const problems: string[] = [];

  for (const row of rows) {
    const record = asRecord(row);
    if (!manifestCache.has(row.pageId)) {
      manifestCache.set(row.pageId, readPageManifest(dataRoot, row.pageId));
    }
    const manifest = manifestCache.get(row.pageId) ?? null;
    const entry = manifest?.lines.find((line) => line.idx === row.idx);
    const localFile = expectedLocalFile(record);
    const path = localFile
      ? join(pageDataDir(dataRoot, row.pageId), localFile)
      : "";

    const local = readLocalImageFacts(path);
    if (!local) {
      problems.push(`page ${row.pageId} line ${row.idx}: local image is missing or unreadable`);
      continue;
    }

    const problem =
      manifestLineProblem(record, entry) ??
      localImageProblem(record, entry?.sha256 ?? null, local);

    if (problem) {
      problems.push(`page ${row.pageId} line ${row.idx}: ${problem}`);
      continue;
    }

    facts.set(row.id, { path, facts: local });
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join("\n");
    const more = problems.length > 8 ? `\nand ${problems.length - 8} more` : "";
    throw new Error(
      `OCR images are not ready for export. Run npm run sync first, then retry.\n${shown}${more}`,
    );
  }

  return { facts };
}

function writeDataset<T>(
  outDir: string,
  name: string,
  split: { train: T[]; val: T[] },
  serialize: (rows: T[]) => string,
): void {
  const dir = join(outDir, name);
  if (split.train.length > 0) {
    writeTextNoOverwrite(join(dir, "train.jsonl"), serialize(split.train));
  }
  if (split.val.length > 0) {
    writeTextNoOverwrite(join(dir, "val.jsonl"), serialize(split.val));
  }
}

function writeOcr(
  outDir: string,
  build: ExportBuild,
  preflight: OcrPreflight,
  createdAt: string,
): void {
  const rows = [...build.ocr.train, ...build.ocr.val].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (rows.length === 0) return;

  const root = join(outDir, "ocr");
  const imagesDir = join(root, "images");
  const valIds = new Set(build.ocr.val.map((row) => row.id));

  for (const row of rows) {
    const source = preflight.facts.get(row.id);
    if (!source) throw new Error(`OCR image ${row.id} was not preflighted`);

    const bytes = readBytes(source.path);
    const hash = sha256Hex(bytes);
    if (hash !== source.facts.sha256) {
      throw new Error(`OCR image ${row.id} changed during export`);
    }
    writeFileNoOverwrite(join(imagesDir, row.imageFile), bytes);
  }

  if (build.ocr.train.length > 0) {
    writeTextNoOverwrite(join(root, "train.jsonl"), ocrJsonl(build.ocr.train));
    writeTextNoOverwrite(join(root, "train.txt"), ocrText(build.ocr.train));
  }
  if (build.ocr.val.length > 0) {
    writeTextNoOverwrite(join(root, "val.jsonl"), ocrJsonl(build.ocr.val));
    writeTextNoOverwrite(join(root, "val.txt"), ocrText(build.ocr.val));
  }

  writeJsonAtomic(join(root, "charset.json"), buildCharset(rows));
  writeJsonAtomic(join(root, "manifest.json"), {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    createdAt,
    prompt: OCR_PROMPT,
    counts: {
      total: rows.length,
      train: build.ocr.train.length,
      val: build.ocr.val.length,
      pages: new Set(rows.map((row) => row.pageId)).size,
    },
    rows: rows.map((row) => ({
      id: row.id,
      pageId: row.pageId,
      lineId: row.lineId,
      line: row.idx,
      image: `images/${row.imageFile}`,
      split: valIds.has(row.id) ? "val" : "train",
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      sha256: preflight.facts.get(row.id)?.facts.sha256 ?? "",
    })),
  });
}

function printSummary(build: ExportBuild, outDir: string): void {
  console.log("");
  console.log(`output: ${displayPath(outDir)}`);
  console.log(
    `approved records: instructions ${build.counts.instructionTranslations}, conversations ${build.counts.conversationTranslations}, text ${build.counts.textSubmissions}, OCR lines ${build.counts.ocrLines}`,
  );
  console.log(`cpt: train ${build.counts.cpt.train}, val ${build.counts.cpt.val}`);
  console.log(`sft: train ${build.counts.sft.train}, val ${build.counts.sft.val}`);
  console.log(
    `sft_multiturn: train ${build.counts.sftMultiturn.train}, val ${build.counts.sftMultiturn.val}`,
  );
  console.log(
    `parallel: train ${build.counts.parallel.train}, val ${build.counts.parallel.val}`,
  );
  console.log(
    `ocr: train ${build.counts.ocr.train}, val ${build.counts.ocr.val}, pages ${build.counts.ocrPages}`,
  );
  console.log(`contributors in csv: ${build.contributors.length}`);
  for (const warning of build.warnings) console.log(`warning: ${warning}`);
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const outDir = resolve(options.out ?? timestampDir());
  const dataRoot = resolve(options.data);

  const supabase = createAdminClient();
  const input = fetchExportInput(supabase);
  void input
    .then((rows) => {
      const build = buildExportData(rows);
      if (
        build.counts.instructionTranslations +
          build.counts.conversationTranslations +
          build.counts.textSubmissions +
          build.counts.ocrLines ===
        0
      ) {
        fail("No approved records to export. Nothing was written.");
      }

      const ocrRows = [...build.ocr.train, ...build.ocr.val];
      const preflight = preflightOcr(ocrRows, dataRoot);
      printSummary(build, outDir);

      if (options.dryRun) {
        console.log("dry run: no files were written");
        return;
      }

      ensureDir(dirname(outDir));
      try {
        mkdirSync(outDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          fail(`Output already exists and was not overwritten: ${displayPath(outDir)}`);
        }
        throw error;
      }

      const createdAt = new Date().toISOString();
      writeDataset(outDir, "cpt", build.cpt, (rows) => toJsonl(rows));
      writeDataset(outDir, "sft", build.sft, (rows) => toJsonl(rows));
      writeDataset(outDir, "sft_multiturn", build.sftMultiturn, (rows) =>
        toJsonl(rows),
      );
      writeDataset(outDir, "parallel", build.parallel, (rows) => toJsonl(rows));
      writeOcr(outDir, build, preflight, createdAt);

      writeTextNoOverwrite(
        join(outDir, "DATASET_NOTES.md"),
        datasetNotes(build.counts, createdAt),
      );
      writeTextNoOverwrite(
        join(outDir, "contributors.csv"),
        contributorsCsv(build.contributors),
      );
      writeJsonAtomic(join(outDir, "manifest.json"), {
        schemaVersion: EXPORT_SCHEMA_VERSION,
        createdAt,
        normalization: [
          "NFC",
          "U+064A and U+0649 mapped to U+06CC",
          "U+0643 mapped to U+06A9",
          "control characters removed, ZWNJ kept",
          "whitespace collapsed, paragraph breaks kept",
        ],
        split: {
          method: "sha1(item id) < 0.05 puts an item in val",
          fallback: "all records stay in train when either side would be empty",
          ocr: "page id first, line id fallback when at least 20 lines",
        },
        ocrPrompt: OCR_PROMPT,
        valRatio: VAL_RATIO,
        counts: {
          ...build.counts,
        },
        warnings: build.warnings,
      });

      console.log(`manifest: ${displayPath(join(outDir, "manifest.json"))}`);

      if (options.latest && basename(dirname(outDir)) === "exports") {
        const latest = updateLatestLink(dirname(outDir), outDir);
        if (latest.status === "updated") {
          console.log(`latest: ${displayPath(join(dirname(outDir), "latest"))}`);
        } else {
          console.log(`warning: ${latest.reason}`);
        }
      } else if (options.latest) {
        console.log(
          "warning: latest was not updated because the output is outside an exports directory",
        );
      }

      console.log("done");
    })
    .catch((error: unknown) => {
      fail(error instanceof Error ? error.message : "Export failed");
    });
}

void main();
