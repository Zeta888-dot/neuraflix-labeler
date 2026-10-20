import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAutoChecks,
  conversationTurnsChanged,
  emptyReviewCounts,
  instructionValuesChanged,
  parseFeedbackRows,
  parseReviewCounts,
  parseReviewItem,
  reviewConversationSchema,
  reviewDecisionSchema,
  reviewDateLabel,
  reviewInstructionSchema,
  reviewKindSingular,
  reviewOcrSchema,
  reviewTextSchema,
  type ReviewConversationItem,
  type ReviewInstructionItem,
} from "./review";

const ID = "11111111-1111-4111-8111-111111111111";

test("review counts parse every queue and the self review setting", () => {
  const parsed = parseReviewCounts([
    { out_kind: "instruction", out_submitted: 2, out_allow_self_review: false },
    { out_kind: "conversation", out_submitted: 0, out_allow_self_review: false },
    { out_kind: "text", out_submitted: 4, out_allow_self_review: false },
    { out_kind: "ocr", out_submitted: 1, out_allow_self_review: false },
  ]);

  assert.ok(parsed);
  assert.deepEqual(parsed?.counts, {
    ...emptyReviewCounts,
    instruction: 2,
    text: 4,
    ocr: 1,
  });
  assert.equal(parsed?.allowSelfReview, false);
});

test("review counts reject a missing queue or a bad number", () => {
  assert.equal(
    parseReviewCounts([
      { out_kind: "instruction", out_submitted: 1, out_allow_self_review: true },
    ]),
    null,
  );
  assert.equal(parseReviewCounts([{ out_kind: "nope" }]), null);
  assert.equal(
    parseReviewCounts([
      { out_kind: "instruction", out_submitted: -1, out_allow_self_review: false },
      { out_kind: "conversation", out_submitted: 0, out_allow_self_review: false },
      { out_kind: "text", out_submitted: 0, out_allow_self_review: false },
      { out_kind: "ocr", out_submitted: 0, out_allow_self_review: false },
    ]),
    null,
  );
});

test("an instruction queue row becomes the UI item", () => {
  const parsed = parseReviewItem({
    out_kind: "instruction",
    out_id: ID,
    out_english: {
      instruction: "Say hello.",
      input: null,
      response: "Hello!",
    },
    out_source: "sample",
    out_created_at: "2026-01-02T03:04:05Z",
    out_khowar_instruction: "سلام",
    out_khowar_input: null,
    out_khowar_response: "سلام",
  });

  assert.ok(parsed);
  assert.equal(parsed?.kind, "instruction");
  if (parsed?.kind === "instruction") {
    assert.equal(parsed.values.khowar_input, "");
    assert.equal(parsed.english.instruction, "Say hello.");
    assert.equal(parsed.createdLabel, "Jan 2, 2026");
  }
});

test("conversation, text and OCR queue rows parse", () => {
  const conversation = parseReviewItem({
    out_kind: "conversation",
    out_id: ID,
    out_english: {
      turns: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    },
    out_source: null,
    out_created_at: "2026-01-02T03:04:05Z",
    out_turns: [
      { role: "user", content: "سلام" },
      { role: "assistant", content: "سلام" },
    ],
  });
  assert.ok(conversation?.kind === "conversation");

  const text = parseReviewItem({
    out_kind: "text",
    out_id: ID,
    out_created_at: "2026-01-02T03:04:05Z",
    out_title: "A title",
    out_source_note: "A note",
    out_khowar_text: "سلام",
  });
  assert.ok(text?.kind === "text");
  if (text?.kind === "text") assert.equal(text.title, "A title");

  const ocr = parseReviewItem({
    out_kind: "ocr",
    out_id: ID,
    out_created_at: "2026-01-02T03:04:05Z",
    out_page_label: "Page one",
    out_line_count: 3,
  });
  assert.ok(ocr?.kind === "ocr");
  if (ocr?.kind === "ocr") {
    assert.equal(ocr.lineCount, 3);
    assert.deepEqual(ocr.lines, []);
  }
});

test("a broken queue row is never shown", () => {
  assert.equal(parseReviewItem(null), null);
  assert.equal(
    parseReviewItem({ out_kind: "instruction", out_id: "not-a-uuid" }),
    null,
  );
  assert.equal(
    parseReviewItem({
      out_kind: "ocr",
      out_id: ID,
      out_created_at: "2026-01-02T03:04:05Z",
      out_line_count: -2,
    }),
    null,
  );
});

test("feedback rows parse with kind and date labels", () => {
  const rows = parseFeedbackRows([
    {
      out_kind: "text",
      out_id: ID,
      out_preview: "سلام",
      out_status: "rejected",
      out_reviewer_edited: false,
      out_review_note: " Please use the Khowar letters. ",
      out_reviewed_at: "2026-02-03T10:00:00Z",
    },
  ]);

  assert.ok(rows);
  assert.equal(rows?.length, 1);
  assert.equal(rows?.[0].kindLabel, reviewKindSingular.text);
  assert.equal(rows?.[0].reviewNote, "Please use the Khowar letters.");
  assert.equal(rows?.[0].reviewedLabel, "Feb 3, 2026");
  assert.equal(parseFeedbackRows("nope"), null);
});

test("review dates are English and UTC", () => {
  assert.equal(reviewDateLabel("2026-01-02T23:30:00Z"), "Jan 2, 2026");
  assert.equal(reviewDateLabel(null), "");
  assert.equal(reviewDateLabel("not a date"), "");
});

test("a rejection always needs a note of at least 3 characters", () => {
  const empty = reviewDecisionSchema.safeParse({
    decision: "reject",
    note: "",
  });
  assert.equal(empty.success, false);

  const short = reviewDecisionSchema.safeParse({
    decision: "reject",
    note: "  x  ",
  });
  assert.equal(short.success, false);

  assert.equal(
    reviewDecisionSchema.safeParse({ decision: "reject", note: "Fix" }).success,
    true,
  );
  assert.equal(
    reviewDecisionSchema.safeParse({ decision: "approve", note: "" }).success,
    true,
  );
});

test("instruction decisions validate values on approve only", () => {
  const base = {
    kind: "instruction" as const,
    translationId: ID,
    note: "",
    english: { instruction: "Say hello.", input: null, response: "Hello!" },
  };

  const valid = reviewInstructionSchema().safeParse({
    ...base,
    decision: "approve",
    values: {
      khowar_instruction: "سلام",
      khowar_input: "",
      khowar_response: "سلام",
    },
  });
  assert.equal(valid.success, true);

  const copied = reviewInstructionSchema().safeParse({
    ...base,
    decision: "approve",
    values: {
      khowar_instruction: "Say hello.",
      khowar_input: "",
      khowar_response: "سلام",
    },
  });
  assert.equal(copied.success, false);

  const rejected = reviewInstructionSchema().safeParse({
    ...base,
    decision: "reject",
    note: "Bad text",
    values: { khowar_instruction: "", khowar_input: "", khowar_response: "" },
  });
  assert.equal(rejected.success, true);
});

test("conversation decisions keep the English turn count", () => {
  const base = {
    kind: "conversation" as const,
    translationId: ID,
    note: "Looks fine",
    englishTurns: [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ],
  };

  assert.equal(
    reviewConversationSchema().safeParse({
      ...base,
      decision: "approve",
      turns: [
        { role: "user", content: "سلام" },
        { role: "assistant", content: "سلام" },
      ],
    }).success,
    true,
  );

  assert.equal(
    reviewConversationSchema().safeParse({
      ...base,
      decision: "approve",
      turns: [{ role: "user", content: "سلام" }],
    }).success,
    false,
  );
});

test("text decisions check the text on approve but still allow a rejection", () => {
  const base = {
    kind: "text" as const,
    submissionId: ID,
    note: "",
  };

  assert.equal(
    reviewTextSchema().safeParse({
      ...base,
      decision: "approve",
      text: "سلام",
    }).success,
    false,
  );

  assert.equal(
    reviewTextSchema().safeParse({
      ...base,
      decision: "approve",
      text: "سلام دنیا، یہ ایک لمبا متن ہے۔",
    }).success,
    true,
  );

  assert.equal(
    reviewTextSchema().safeParse({
      ...base,
      decision: "reject",
      note: "Too short",
      text: "سلام",
    }).success,
    true,
  );
});

test("OCR decisions need one kept line with a valid label", () => {
  const base = {
    kind: "ocr" as const,
    pageId: ID,
    note: "",
  };

  assert.equal(
    reviewOcrSchema().safeParse({
      ...base,
      decision: "approve",
      lines: [{ idx: 1, label: "سلام", reject: false }],
    }).success,
    true,
  );

  assert.equal(
    reviewOcrSchema().safeParse({
      ...base,
      decision: "approve",
      lines: [{ idx: 1, label: "", reject: false }],
    }).success,
    false,
  );

  assert.equal(
    reviewOcrSchema().safeParse({
      ...base,
      decision: "approve",
      lines: [{ idx: 1, label: "سلام", reject: true }],
    }).success,
    false,
  );

  assert.equal(
    reviewOcrSchema().safeParse({
      ...base,
      decision: "approve",
      lines: [
        { idx: 1, label: "سلام", reject: false },
        { idx: 1, label: "دوم", reject: false },
      ],
    }).success,
    false,
  );

  assert.equal(
    reviewOcrSchema().safeParse({
      ...base,
      decision: "reject",
      note: "The image is blank",
      lines: [],
    }).success,
    true,
  );
});

test("auto checks flag copied English, Latin text and repetition", () => {
  const copied = buildAutoChecks(
    "instruction",
    {
      khowar_instruction: "سلام",
      khowar_input: "",
      khowar_response: "سلام",
    },
    { instruction: "سلام", input: null, response: "سلام" },
  );
  assert.ok(copied.some((check) => check.id.endsWith("same-as-english")));

  const latin = buildAutoChecks("text", "hello world");
  assert.ok(latin.some((check) => check.id.endsWith("high-latin")));
  assert.ok(
    buildAutoChecks("text", "12345").some((check) =>
      check.id.endsWith("no-arabic"),
    ),
  );

  const repeated = buildAutoChecks("text", "سسسسس");
  assert.ok(
    repeated.some((check) => check.id.endsWith("repeated-characters")),
  );

  assert.deepEqual(buildAutoChecks("ocr", "123 456"), []);
});

test("change detection sees edited instructions and turns", () => {
  const instruction: ReviewInstructionItem = {
    kind: "instruction",
    id: ID,
    source: null,
    createdAt: "2026-01-02T03:04:05Z",
    createdLabel: "Jan 2, 2026",
    english: { instruction: "Hello", input: null, response: "Hi" },
    values: {
      khowar_instruction: "سلام",
      khowar_input: "",
      khowar_response: "سلام",
    },
  };
  assert.equal(instructionValuesChanged(instruction, instruction.values), false);
  assert.equal(
    instructionValuesChanged(instruction, {
      ...instruction.values,
      khowar_response: "دوم",
    }),
    true,
  );

  const conversation: ReviewConversationItem = {
    kind: "conversation",
    id: ID,
    source: null,
    createdAt: "2026-01-02T03:04:05Z",
    createdLabel: "Jan 2, 2026",
    english: {
      turns: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    },
    turns: [
      { role: "user", content: "سلام" },
      { role: "assistant", content: "سلام" },
    ],
  };
  assert.equal(conversationTurnsChanged(conversation, conversation.turns), false);
  assert.equal(
    conversationTurnsChanged(conversation, [
      conversation.turns[0],
      { role: "assistant", content: "دوم" },
    ]),
    true,
  );
});
