import { createHash } from "node:crypto";
import { parseConversationSource } from "../../src/lib/conversations";
import { parseEnglishSource } from "../../src/lib/instructions";
import { validateLabel } from "../../src/lib/ocr/labels";
import {
  countCharacters,
  type ConversationTurn,
  type EnglishSource,
} from "../../src/lib/khowar";
import {
  exportOcrImageFile,
  stableOcrId,
  type OcrImageExtension,
} from "./ocr-paths";
import {
  validateOcrRecord,
  type OcrLineRecord,
} from "./sync-core";

/**
 * Pure export builders. The live export script reads approved rows from
 * Supabase, normalizes them here and writes the returned files. Nothing in
 * this module touches the network, the file system or environment variables.
 *
 * Only rows whose own status is approved, and for OCR whose page is also
 * approved, can enter the output. Draft, submitted and rejected rows are
 * filtered out before any builder runs.
 */

export const EXPORT_SCHEMA_VERSION = "1.0";
export const VAL_RATIO = 0.05;
export const OCR_PROMPT = "<image>\nFree OCR. ";

const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/**
 * Export normalization. NFC, Arabic keyboard confusables mapped to the Khowar
 * letters, invisible direction marks removed, controls removed, ZWNJ kept,
 * tabs turned into spaces, spaces collapsed and paragraph breaks kept.
 */
export function normalizeForExport(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u064A\u0649]/g, "\u06CC")
    .replace(/\u0643/g, "\u06A9")
    .replace(INVISIBLE, "")
    .replace(CONTROL, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One line normalization for instructions, turns and OCR labels. */
export function normalizeInlineForExport(value: string): string {
  return normalizeForExport(value).replace(/\s+/g, " ").trim();
}

/** SHA-1 based deterministic split value, matching the old labeler. */
export function bucket(key: string): number {
  const digest = createHash("sha1").update(key, "utf8").digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

export type Split<T> = { train: T[]; val: T[] };

/**
 * Deterministic 95/5 split. When the hash leaves one side empty, everything
 * stays in train so a tiny dataset never produces a val-only file.
 */
export function splitByKey<T>(
  rows: T[],
  keyOf: (row: T) => string,
): Split<T> {
  const val = rows.filter((row) => bucket(keyOf(row)) < VAL_RATIO);
  const train = rows.filter((row) => bucket(keyOf(row)) >= VAL_RATIO);

  if (val.length === 0 || train.length === 0) {
    return { train: rows, val: [] };
  }

  return { train, val };
}

export type InstructionExportRecord = {
  id: string;
  itemId: string;
  contributorId: string | null;
  status: string;
  khowarInstruction: string;
  khowarInput: string;
  khowarResponse: string;
  english: unknown;
};

export type ConversationExportRecord = {
  id: string;
  itemId: string;
  contributorId: string | null;
  status: string;
  turns: unknown;
  english: unknown;
};

export type TextExportRecord = {
  id: string;
  contributorId: string | null;
  status: string;
  text: string;
};

export type OcrExportRecord = OcrLineRecord & { label: string };

export type ExportInput = {
  instructions: InstructionExportRecord[];
  conversations: ConversationExportRecord[];
  texts: TextExportRecord[];
  ocrLines: OcrExportRecord[];
};

export type CptRow = {
  id: string;
  source: "instruction" | "input" | "response" | "text";
  text: string;
  splitKey: string;
};

export type ChatMessage = { role: string; content: string };

export type ChatRow = {
  id: string;
  messages: ChatMessage[];
  splitKey: string;
};

export type ParallelRow = {
  id: string;
  type: "instruction" | "input" | "response" | "turn";
  en: string;
  khw: string;
  splitKey: string;
};

export type OcrExportLine = {
  id: string;
  pageId: string;
  lineId: string;
  contributorId: string | null;
  idx: number;
  label: string;
  ext: OcrImageExtension;
  imageFile: string;
  storagePath: string;
  bytes: number;
  width: number;
  height: number;
};

export type ContributorExportCount = {
  contributorId: string;
  instructions: number;
  conversations: number;
  texts: number;
  ocrLines: number;
};

export type ExportCounts = {
  instructionTranslations: number;
  conversationTranslations: number;
  textSubmissions: number;
  ocrLines: number;
  ocrPages: number;
  cpt: { train: number; val: number };
  sft: { train: number; val: number };
  sftMultiturn: { train: number; val: number };
  parallel: { train: number; val: number };
  ocr: { train: number; val: number };
};

export type ExportBuild = {
  cpt: Split<CptRow>;
  sft: Split<ChatRow>;
  sftMultiturn: Split<ChatRow>;
  parallel: Split<ParallelRow>;
  ocr: Split<OcrExportLine>;
  counts: ExportCounts;
  contributors: ContributorExportCount[];
  warnings: string[];
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireText(value: string, recordId: string, field: string): string {
  const text = normalizeInlineForExport(value);
  if (text === "") {
    throw new Error(`approved record ${recordId} has an empty ${field}`);
  }
  return text;
}

function requireItemId(itemId: string, recordId: string): string {
  if (itemId.trim() === "") {
    throw new Error(`approved record ${recordId} has no item id`);
  }
  return itemId;
}

function addContributor(
  map: Map<string, ContributorExportCount>,
  contributorId: string | null,
  field: "instructions" | "conversations" | "texts" | "ocrLines",
): void {
  if (!contributorId) return;
  const current = map.get(contributorId) ?? {
    contributorId,
    instructions: 0,
    conversations: 0,
    texts: 0,
    ocrLines: 0,
  };
  current[field] += 1;
  map.set(contributorId, current);
}

function splitOcrLines(rows: OcrExportLine[]): {
  split: Split<OcrExportLine>;
  warning: string | null;
} {
  const pageSplit = splitByKey(rows, (row) => row.pageId);
  if (pageSplit.val.length > 0) {
    return { split: pageSplit, warning: null };
  }

  if (rows.length >= 20) {
    const lineSplit = splitByKey(rows, (row) => row.id);
    if (lineSplit.val.length > 0) {
      return {
        split: lineSplit,
        warning:
          "No OCR page landed in val, so the OCR split fell back to line ids.",
      };
    }
  }

  return { split: { train: rows, val: [] }, warning: null };
}

export function buildExportData(input: ExportInput): ExportBuild {
  const warnings: string[] = [];
  const contributors = new Map<string, ContributorExportCount>();

  const cptRows: CptRow[] = [];
  const sftRows: ChatRow[] = [];
  const multiturnRows: ChatRow[] = [];
  const parallelRows: ParallelRow[] = [];
  const ocrRows: OcrExportLine[] = [];

  let instructionCount = 0;
  for (const record of input.instructions) {
    if (record.status !== "approved") continue;
    instructionCount += 1;

    const english: EnglishSource | null = parseEnglishSource(record.english);
    if (!english) {
      throw new Error(`approved instruction ${record.id} has no usable English source`);
    }

    const enInstruction = normalizeInlineForExport(english.instruction);
    const enResponse = normalizeInlineForExport(english.response);
    if (enInstruction === "" || enResponse === "") {
      throw new Error(`approved instruction ${record.id} has an unusable English source`);
    }
    const enInput = english.input ? normalizeInlineForExport(english.input) : "";
    if (english.input && enInput === "") {
      throw new Error(`approved instruction ${record.id} has an unusable English input`);
    }

    const instruction = requireText(
      record.khowarInstruction,
      record.id,
      "Khowar instruction",
    );
    const response = requireText(
      record.khowarResponse,
      record.id,
      "Khowar response",
    );
    const input = normalizeInlineForExport(record.khowarInput);
    if (enInput !== "" && input === "") {
      throw new Error(`approved instruction ${record.id} has an empty Khowar input`);
    }

    const itemId = requireItemId(record.itemId, record.id);
    const base = `instruction:${record.id}`;

    cptRows.push({
      id: `${base}:instruction`,
      source: "instruction",
      text: instruction,
      splitKey: itemId,
    });
    if (input !== "") {
      cptRows.push({
        id: `${base}:input`,
        source: "input",
        text: input,
        splitKey: itemId,
      });
    }
    cptRows.push({
      id: `${base}:response`,
      source: "response",
      text: response,
      splitKey: itemId,
    });

    const userContent =
      input === ""
        ? instruction
        : `${instruction}\n\n${input}`;

    sftRows.push({
      id: base,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: response },
      ],
      splitKey: itemId,
    });

    parallelRows.push({
      id: `${base}:instruction`,
      type: "instruction",
      en: enInstruction,
      khw: instruction,
      splitKey: itemId,
    });
    if (enInput !== "" && input !== "") {
      parallelRows.push({
        id: `${base}:input`,
        type: "input",
        en: enInput,
        khw: input,
        splitKey: itemId,
      });
    }
    parallelRows.push({
      id: `${base}:response`,
      type: "response",
      en: enResponse,
      khw: response,
      splitKey: itemId,
    });

    addContributor(contributors, record.contributorId, "instructions");
  }

  let conversationCount = 0;
  for (const record of input.conversations) {
    if (record.status !== "approved") continue;
    conversationCount += 1;

    const english = parseConversationSource(record.english);
    const translated = parseConversationSource({ turns: record.turns });
    if (!english || !translated) {
      throw new Error(`approved conversation ${record.id} has unusable turns`);
    }
    if (english.turns.length !== translated.turns.length) {
      throw new Error(`approved conversation ${record.id} has a turn count mismatch`);
    }

    const messages: ChatMessage[] = [];
    for (let index = 0; index < translated.turns.length; index += 1) {
      const englishTurn = english.turns[index];
      const turn = translated.turns[index];
      if (englishTurn.role !== turn.role) {
        throw new Error(`approved conversation ${record.id} has a turn role mismatch`);
      }

      const khw = requireText(
        turn.content,
        record.id,
        `Khowar turn ${index + 1}`,
      );
      const en = normalizeInlineForExport(englishTurn.content);
      if (en === "") {
        throw new Error(`approved conversation ${record.id} has an empty English turn`);
      }

      messages.push({
        role: turn.role,
        content: khw,
      } satisfies ConversationTurn);

      parallelRows.push({
        id: `parallel:conversation:${record.id}:turn:${String(index + 1).padStart(2, "0")}`,
        type: "turn",
        en,
        khw,
        splitKey: requireItemId(record.itemId, record.id),
      });
    }

    multiturnRows.push({
      id: `conversation:${record.id}`,
      messages,
      splitKey: requireItemId(record.itemId, record.id),
    });

    addContributor(contributors, record.contributorId, "conversations");
  }

  let textCount = 0;
  for (const record of input.texts) {
    if (record.status !== "approved") continue;
    textCount += 1;

    const text = normalizeForExport(record.text);
    if (text === "") {
      throw new Error(`approved text ${record.id} is empty after normalization`);
    }

    cptRows.push({
      id: `text:${record.id}`,
      source: "text",
      text,
      splitKey: record.id,
    });
    addContributor(contributors, record.contributorId, "texts");
  }

  let ocrCount = 0;
  for (const record of input.ocrLines) {
    if (record.status !== "approved" || record.pageStatus !== "approved") continue;
    const check = validateOcrRecord(record);
    if (!check.ok) {
      throw new Error(
        `approved OCR line ${record.id} cannot be exported: ${check.reason}`,
      );
    }

    const label = normalizeInlineForExport(record.label);
    if (label === "" || countCharacters(label) > 400) {
      throw new Error(`approved OCR line ${record.id} has an unusable label`);
    }
    const validation = validateLabel(label);
    if (!validation.ok) {
      throw new Error(`approved OCR line ${record.id} has an unusable label`);
    }

    ocrCount += 1;
    ocrRows.push({
      id: stableOcrId(record.pageId, record.idx),
      pageId: record.pageId,
      lineId: record.id,
      contributorId: record.contributorId,
      idx: record.idx,
      label,
      ext: check.ext,
      imageFile: exportOcrImageFile(record.pageId, record.idx, check.ext),
      storagePath: record.storagePath ?? "",
      bytes: record.bytes,
      width: record.width,
      height: record.height,
    });
    addContributor(contributors, record.contributorId, "ocrLines");
  }

  cptRows.sort((a, b) => compareText(a.id, b.id));
  sftRows.sort((a, b) => compareText(a.id, b.id));
  multiturnRows.sort((a, b) => compareText(a.id, b.id));
  parallelRows.sort((a, b) => compareText(a.id, b.id));
  ocrRows.sort((a, b) => compareText(a.id, b.id));

  const cpt = splitByKey(cptRows, (row) => row.splitKey);
  const sft = splitByKey(sftRows, (row) => row.splitKey);
  const sftMultiturn = splitByKey(multiturnRows, (row) => row.splitKey);
  const parallel = splitByKey(parallelRows, (row) => row.splitKey);
  const ocrSplit = splitOcrLines(ocrRows);
  if (ocrSplit.warning) warnings.push(ocrSplit.warning);

  return {
    cpt,
    sft,
    sftMultiturn,
    parallel,
    ocr: ocrSplit.split,
    counts: {
      instructionTranslations: instructionCount,
      conversationTranslations: conversationCount,
      textSubmissions: textCount,
      ocrLines: ocrCount,
      ocrPages: new Set(ocrRows.map((row) => row.pageId)).size,
      cpt: { train: cpt.train.length, val: cpt.val.length },
      sft: { train: sft.train.length, val: sft.val.length },
      sftMultiturn: {
        train: sftMultiturn.train.length,
        val: sftMultiturn.val.length,
      },
      parallel: { train: parallel.train.length, val: parallel.val.length },
      ocr: { train: ocrSplit.split.train.length, val: ocrSplit.split.val.length },
    },
    contributors: [...contributors.values()].sort((a, b) =>
      compareText(a.contributorId, b.contributorId),
    ),
    warnings,
  };
}

export function toJsonl(rows: unknown[]): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export function ocrJsonl(rows: OcrExportLine[]): string {
  return toJsonl(
    rows.map((row) => ({
      id: row.id,
      messages: [
        {
          role: "<|User|>",
          content: OCR_PROMPT,
          images: [`images/${row.imageFile}`],
        },
        { role: "<|Assistant|>", content: row.label },
      ],
    })),
  );
}

export function ocrText(rows: OcrExportLine[]): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => `images/${row.imageFile}\t${row.label}`).join("\n")}\n`;
}

export type CharsetEntry = { char: string; code: string; count: number };

export function buildCharset(rows: OcrExportLine[]): CharsetEntry[] {
  const frequency = new Map<string, number>();
  for (const row of rows) {
    for (const char of Array.from(row.label)) {
      frequency.set(char, (frequency.get(char) ?? 0) + 1);
    }
  }

  return [...frequency.entries()]
    .map(([char, count]) => ({
      char,
      code: `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
      count,
    }))
    .sort((a, b) => b.count - a.count || compareText(a.code, b.code));
}

export function contributorsCsv(rows: ContributorExportCount[]): string {
  const header =
    "contributor_id,instruction_translations,conversation_translations,text_submissions,ocr_lines";
  const body = rows.map(
    (row) =>
      `${row.contributorId},${row.instructions},${row.conversations},${row.texts},${row.ocrLines}`,
  );
  return `${[header, ...body].join("\n")}\n`;
}

const NOTES_EXAMPLES = {
  cpt: JSON.stringify({
    id: "text:00000000-0000-4000-8000-000000000001",
    source: "text",
    text: "دا یوه بېلګه ده.",
  }),
  sft: JSON.stringify({
    id: "instruction:00000000-0000-4000-8000-000000000002",
    messages: [
      {
        role: "user",
        content: "دا لارښوونه ده.\n\nدا اختیاري برخه ده.",
      },
      { role: "assistant", content: "دا ځواب دی." },
    ],
  }),
  sftMultiturn: JSON.stringify({
    id: "conversation:00000000-0000-4000-8000-000000000003",
    messages: [
      { role: "user", content: "دا لومړۍ پوښتنه ده." },
      { role: "assistant", content: "دا لومړی ځواب دی." },
    ],
  }),
  parallel: JSON.stringify({
    id: "instruction:00000000-0000-4000-8000-000000000002:instruction",
    type: "instruction",
    en: "This is an example instruction.",
    khw: "دا یوه بېلګه لارښوونه ده.",
  }),
  ocr: JSON.stringify({
    id: "00000000-0000-4000-8000-000000000004_03",
    messages: [
      {
        role: "<|User|>",
        content: OCR_PROMPT,
        images: ["images/00000000-0000-4000-8000-000000000004_03.webp"],
      },
      { role: "<|Assistant|>", content: "دا یوه بېلګه کرښه ده." },
    ],
  }),
};

/**
 * Human readable notes written beside the export. The counts are the same
 * numbers as manifest.json, and every example is a placeholder.
 */
export function datasetNotes(counts: ExportCounts, createdAt: string): string {
  return `${[
    "# Dataset notes",
    "",
    `Exported: ${createdAt}`,
    "",
    "## Purpose",
    "",
    "This folder is a snapshot of approved Khowar contributions from the NeuraFlix Labeler. It is shaped for training and evaluating Khowar language models. Only rows approved by a reviewer are included. The database remains the source of truth.",
    "",
    "## Counts",
    "",
    "These are the same counts written to manifest.json.",
    "",
    "| Approved source rows | Count |",
    "| --- | --- |",
    `| Instruction translations | ${counts.instructionTranslations} |`,
    `| Conversation translations | ${counts.conversationTranslations} |`,
    `| Plain text submissions | ${counts.textSubmissions} |`,
    `| OCR lines | ${counts.ocrLines} |`,
    `| OCR pages | ${counts.ocrPages} |`,
    "",
    "| Split | train | val |",
    "| --- | --- | --- |",
    `| cpt | ${counts.cpt.train} | ${counts.cpt.val} |`,
    `| sft | ${counts.sft.train} | ${counts.sft.val} |`,
    `| sft_multiturn | ${counts.sftMultiturn.train} | ${counts.sftMultiturn.val} |`,
    `| parallel | ${counts.parallel.train} | ${counts.parallel.val} |`,
    `| ocr | ${counts.ocr.train} | ${counts.ocr.val} |`,
    "",
    "## File schemas",
    "",
    "One example line for each split. The values are placeholders, not rows from this export.",
    "",
    "### cpt/train.jsonl and cpt/val.jsonl",
    "",
    "Plain text documents. `source` is instruction, input, response or text.",
    "",
    "```jsonl",
    NOTES_EXAMPLES.cpt,
    "```",
    "",
    "### sft/train.jsonl and sft/val.jsonl",
    "",
    "One user turn and one assistant turn. The user content is the Khowar instruction, plus a blank line and the input when the source has one.",
    "",
    "```jsonl",
    NOTES_EXAMPLES.sft,
    "```",
    "",
    "### sft_multiturn/train.jsonl and sft_multiturn/val.jsonl",
    "",
    "Full conversations in original turn order. Roles are system, user and assistant.",
    "",
    "```jsonl",
    NOTES_EXAMPLES.sftMultiturn,
    "```",
    "",
    "### parallel/train.jsonl and parallel/val.jsonl",
    "",
    "English and Khowar pairs. `type` is instruction, input, response or turn.",
    "",
    "```jsonl",
    NOTES_EXAMPLES.parallel,
    "```",
    "",
    "### ocr/train.jsonl and ocr/val.jsonl",
    "",
    "OCR lines with their image path. Images live in `ocr/images/`. The prompt is `<image>` followed by a newline and `Free OCR. `.",
    "",
    "```jsonl",
    NOTES_EXAMPLES.ocr,
    "```",
    "",
    "The OCR folder also has `train.txt` and `val.txt` (`images/<name><TAB><label>`), `charset.json`, and `manifest.json` with row level image facts.",
    "",
    "## Normalization",
    "",
    "Normalization runs at export time. Raw text stays in the database.",
    "",
    "- NFC",
    "- U+064A and U+0649 mapped to U+06CC",
    "- U+0643 mapped to U+06A9",
    "- Control and invisible characters removed, ZWNJ kept",
    "- Whitespace collapsed, paragraph breaks kept in plain text",
    "",
    "## Split rules",
    "",
    "- SHA-1 of the source item id decides the split. A value below 0.05 goes to val.",
    "- Records from one source item stay together.",
    "- OCR groups lines by page id, and falls back to line id when a page has 20 or more lines.",
    "- If either side would be empty, all rows stay in train.",
    "- Output order is sorted by id.",
    "",
    "## Privacy",
    "",
    "This export contains no personal data; contributors.csv is pseudonymous and for admin use only. No contributor names or emails are written into a manifest.",
    "",
    "## Licence",
    "",
    "Licence: to be decided before any public release.",
    "",
    "## How to load",
    "",
    "```python",
    'from datasets import load_dataset',
    'from transformers import AutoTokenizer',
    "",
    'tokenizer = AutoTokenizer.from_pretrained("your-model")',
    "dataset = load_dataset(",
    '    "json",',
    '    data_files={"train": "sft/train.jsonl", "validation": "sft/val.jsonl"},',
    ")",
    "",
    "def render(row):",
    '    return tokenizer.apply_chat_template(row["messages"], tokenize=False)',
    "",
    'train_texts = [render(row) for row in dataset["train"]]',
    "```",
    "",
    "Chat templates are not stored in this export. tokenizer.apply_chat_template is applied at training time, so the same files work with another tokenizer.",
  ].join("\n")}\n`;
}
