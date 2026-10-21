import assert from "node:assert/strict";
import test from "node:test";
import {
  OCR_PROMPT,
  buildCharset,
  buildExportData,
  contributorsCsv,
  datasetNotes,
  normalizeForExport,
  normalizeInlineForExport,
  ocrJsonl,
  splitByKey,
  toJsonl,
  type ConversationExportRecord,
  type InstructionExportRecord,
  type OcrExportRecord,
  type TextExportRecord,
} from "./export-core";

const ITEM = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const RECORD = "44444444-4444-4444-8444-444444444444";
const RECORD_2 = "55555555-5555-4555-8555-555555555555";
const PAGE = "66666666-6666-4666-8666-666666666666";
const PAGE_2 = "77777777-7777-4777-8777-777777777777";

function instruction(
  overrides: Partial<InstructionExportRecord> = {},
): InstructionExportRecord {
  return {
    id: RECORD,
    itemId: ITEM,
    contributorId: USER,
    status: "approved",
    khowarInstruction: "سلام",
    khowarInput: "نام",
    khowarResponse: "ښه",
    english: {
      instruction: "Hello",
      input: "Name",
      response: "Good",
    },
    ...overrides,
  };
}

function conversation(
  overrides: Partial<ConversationExportRecord> = {},
): ConversationExportRecord {
  return {
    id: RECORD,
    itemId: ITEM,
    contributorId: USER,
    status: "approved",
    english: {
      turns: [
        { role: "user", content: "Where?" },
        { role: "assistant", content: "Here." },
      ],
    },
    turns: [
      { role: "user", content: "کوت؟" },
      { role: "assistant", content: "دا." },
    ],
    ...overrides,
  };
}

function text(overrides: Partial<TextExportRecord> = {}): TextExportRecord {
  return {
    id: RECORD,
    contributorId: USER,
    status: "approved",
    text: "دا یو متن دی.",
    ...overrides,
  };
}

function ocr(overrides: Partial<OcrExportRecord> = {}): OcrExportRecord {
  return {
    id: RECORD_2,
    contributorId: USER,
    pageId: PAGE,
    idx: 3,
    label: "سلام",
    status: "approved",
    pageStatus: "approved",
    storagePath: `${USER}/${PAGE}/3.webp`,
    width: 120,
    height: 40,
    bytes: 2048,
    exportedAt: "2026-10-20T10:00:00.000Z",
    purgedAt: null,
    ...overrides,
  };
}

test("normalization maps Arabic keyboard letters and keeps ZWNJ and breaks", () => {
  const source = "  \u064A \u0649 \u0643 \r\n\r\n\r\nک\u200Cتاب  ";
  const normalized = normalizeForExport(source);
  assert.equal(normalized, "\u06CC \u06CC \u06A9\n\nک\u200Cتاب");
  assert.equal(normalizeInlineForExport("a\nb\tc"), "a b c");
});

test("only approved rows enter the export", () => {
  const input = {
    instructions: [
      instruction(),
      instruction({ id: RECORD_2, status: "rejected" }),
      instruction({ id: RECORD_2, status: "submitted" }),
      instruction({ id: RECORD_2, status: "draft" }),
    ],
    conversations: [
      conversation(),
      conversation({ id: RECORD_2, status: "rejected" }),
    ],
    texts: [
      text(),
      text({ id: RECORD_2, status: "submitted" }),
      text({ id: RECORD_2, status: "rejected" }),
    ],
    ocrLines: [
      ocr(),
      ocr({ id: RECORD, pageId: PAGE_2, storagePath: `${USER}/${PAGE_2}/3.webp`, status: "rejected" }),
      ocr({ id: RECORD, pageId: PAGE_2, storagePath: `${USER}/${PAGE_2}/3.webp`, pageStatus: "rejected" }),
    ],
  };

  const built = buildExportData(input);

  assert.equal(built.counts.instructionTranslations, 1);
  assert.equal(built.counts.conversationTranslations, 1);
  assert.equal(built.counts.textSubmissions, 1);
  assert.equal(built.counts.ocrLines, 1);
  assert.equal(built.ocr.train.length + built.ocr.val.length, 1);
  assert.equal(built.sftMultiturn.train.length + built.sftMultiturn.val.length, 1);

  const serialized = JSON.stringify(built);
  assert.ok(!serialized.includes("rejected"));
  assert.ok(!serialized.includes("submitted"));
});

test("sft uses the Khowar instruction, input and response in order", () => {
  const built = buildExportData({
    instructions: [instruction()],
    conversations: [],
    texts: [],
    ocrLines: [],
  });

  const row = built.sft.train[0];
  assert.ok(row);
  assert.equal(row.messages[0].role, "user");
  assert.equal(row.messages[0].content, "سلام\n\nنام");
  assert.equal(row.messages[1].role, "assistant");
  assert.equal(row.messages[1].content, "ښه");
  assert.equal(built.counts.cpt.train, 3);
});

test("conversation roles and order are preserved", () => {
  const built = buildExportData({
    instructions: [],
    conversations: [conversation()],
    texts: [],
    ocrLines: [],
  });

  const row = built.sftMultiturn.train[0];
  assert.ok(row);
  assert.deepEqual(
    row.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(row.messages[0].content, "کوت؟");

  const turns = built.parallel.train.filter((entry) => entry.type === "turn");
  assert.equal(turns.length, 2);
  assert.deepEqual(
    turns.map((entry) => entry.en),
    ["Where?", "Here."],
  );
});

test("the split is deterministic and tiny data stays in train", () => {
  const rows = Array.from({ length: 80 }, (_, index) => `record-${index}`);
  const first = splitByKey(rows, (row) => row);
  const second = splitByKey(rows, (row) => row);

  assert.deepEqual(first, second);
  assert.equal(first.train.length + first.val.length, rows.length);
  assert.ok(first.train.length > 0);

  const tiny = splitByKey(["only-one"], (row) => row);
  assert.deepEqual(tiny, { train: ["only-one"], val: [] });
});

test("repeated builds serialize identically", () => {
  const input = {
    instructions: [instruction()],
    conversations: [conversation()],
    texts: [text()],
    ocrLines: [ocr()],
  };
  const first = buildExportData(input);
  const second = buildExportData(input);

  assert.equal(
    toJsonl(first.cpt.train),
    toJsonl(second.cpt.train),
  );
  assert.equal(
    toJsonl(first.parallel.train),
    toJsonl(second.parallel.train),
  );
  assert.equal(first.counts.cpt.train, second.counts.cpt.train);
});

test("jsonl has one compact object per line and a trailing newline", () => {
  assert.equal(toJsonl([]), "");
  assert.equal(toJsonl([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
});

test("OCR ids and image names are stable and never use the full page", () => {
  const built = buildExportData({
    instructions: [],
    conversations: [],
    texts: [],
    ocrLines: [ocr()],
  });
  const row = built.ocr.train[0];
  assert.ok(row);
  assert.equal(row.id, `${PAGE}_03`);
  assert.equal(row.imageFile, `${PAGE}_03.webp`);
  assert.equal(row.label, "سلام");
  assert.ok(!row.imageFile.includes("page"));

  const parsed = JSON.parse(ocrJsonl([row])) as {
    messages: Array<{ role: string; content: string; images?: string[] }>;
  };
  assert.equal(parsed.messages[0].role, "<|User|>");
  assert.equal(parsed.messages[0].content, OCR_PROMPT);
  assert.deepEqual(parsed.messages[0].images, [`images/${PAGE}_03.webp`]);
  assert.equal(parsed.messages[1].content, "سلام");
});

test("OCR splits keep every line from one page together", () => {
  const rows: OcrExportRecord[] = [];
  for (let index = 1; index <= 8; index += 1) {
    rows.push(
      ocr({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        idx: index,
        storagePath: `${USER}/${PAGE}/${index}.webp`,
      }),
    );
  }
  for (let index = 1; index <= 5; index += 1) {
    rows.push(
      ocr({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        pageId: PAGE_2,
        idx: index,
        storagePath: `${USER}/${PAGE_2}/${index}.webp`,
      }),
    );
  }

  const built = buildExportData({
    instructions: [],
    conversations: [],
    texts: [],
    ocrLines: rows,
  });

  const splitByPage = new Map<string, Set<string>>();
  for (const row of built.ocr.train) {
    const split = splitByPage.get(row.pageId) ?? new Set<string>();
    split.add("train");
    splitByPage.set(row.pageId, split);
  }
  for (const row of built.ocr.val) {
    const split = splitByPage.get(row.pageId) ?? new Set<string>();
    split.add("val");
    splitByPage.set(row.pageId, split);
  }

  assert.equal(splitByPage.size, 2);
  for (const splits of splitByPage.values()) {
    assert.equal(splits.size, 1);
  }
});

test("charset and contributors are real counts", () => {
  const built = buildExportData({
    instructions: [],
    conversations: [],
    texts: [],
    ocrLines: [
      ocr({ idx: 1, storagePath: `${USER}/${PAGE}/1.webp`, label: "اا ب" }),
      ocr({
        id: RECORD,
        idx: 2,
        storagePath: `${USER}/${PAGE}/2.webp`,
        label: "ا",
      }),
    ],
  });

  const charset = buildCharset(built.ocr.train);
  assert.deepEqual(
    charset.map((entry) => entry.char),
    ["ا", " ", "ب"],
  );
  assert.equal(charset[0].count, 3);

  const csv = contributorsCsv(built.contributors);
  assert.match(csv, /^contributor_id,instruction_translations,/);
  assert.match(csv, new RegExp(`^${USER},0,0,0,2$`, "m"));
});

test("dataset notes cover every split, the counts and the policy lines", () => {
  const built = buildExportData({
    instructions: [instruction()],
    conversations: [conversation()],
    texts: [text()],
    ocrLines: [ocr()],
  });
  const notes = datasetNotes(built.counts, "2026-10-22T00:00:00.000Z");

  for (const name of ["cpt", "sft", "sft_multiturn", "parallel", "ocr"]) {
    assert.match(notes, new RegExp(`### ${name}/`));
  }

  for (const [name, split] of [
    ["cpt", built.counts.cpt],
    ["sft", built.counts.sft],
    ["sft_multiturn", built.counts.sftMultiturn],
    ["parallel", built.counts.parallel],
    ["ocr", built.counts.ocr],
  ] as const) {
    assert.match(
      notes,
      new RegExp(`\\| ${name} \\| ${split.train} \\| ${split.val} \\|`),
    );
  }

  assert.match(notes, /contains no personal data; contributors\.csv is pseudonymous and for admin use only/);
  assert.match(notes, /to be decided before any public release/);
  assert.match(notes, /tokenizer\.apply_chat_template is applied at training time/);
  assert.match(notes, /Free OCR\./);
});

test("invalid paths, empty approved text and turn mismatches fail loudly", () => {
  assert.throws(
    () =>
      buildExportData({
        instructions: [],
        conversations: [],
        texts: [],
        ocrLines: [
          ocr({ storagePath: `${USER}/${PAGE_2}/3.webp` }),
        ],
      }),
    /cannot be exported/,
  );

  assert.throws(
    () =>
      buildExportData({
        instructions: [instruction({ khowarInstruction: "  " })],
        conversations: [],
        texts: [],
        ocrLines: [],
      }),
    /empty Khowar instruction/,
  );

  assert.throws(
    () =>
      buildExportData({
        instructions: [],
        conversations: [
          conversation({
            turns: [{ role: "user", content: "یوازې" }],
          }),
        ],
        texts: [],
        ocrLines: [],
      }),
    /turn count mismatch/,
  );
});
