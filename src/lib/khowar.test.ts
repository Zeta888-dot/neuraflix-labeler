import assert from "node:assert/strict";
import { test } from "node:test";
import {
  conversationTranslationSchema,
  countCharacters,
  englishHashSource,
  instructionTranslationSchema,
  khowarLengthWarning,
  khowarLetterStats,
  khowarTextError,
  normalizeKhowar,
  normalizePlainText,
  normalizeWhitespace,
  plainTextHashSource,
  plainTextSubmissionSchema,
  validateConversationTranslation,
  validateInstructionTranslation,
} from "./khowar";

test("normalizeKhowar keeps ZWNJ and drops controls", () => {
  assert.equal(normalizeKhowar("  الف\u200C  ب  "), "الف\u200C ب");
  assert.equal(normalizeKhowar("a\u0000b\u0007c"), "abc");
  assert.equal(normalizeKhowar("a\nb"), "a\nb");
});

test("normalizeWhitespace collapses newlines and trims", () => {
  assert.equal(normalizeWhitespace("  a \n\n b  "), "a b");
});

test("englishHashSource joins instruction and optional input", () => {
  assert.equal(englishHashSource("Hello", "World"), "Hello\nWorld");
  assert.equal(englishHashSource("Hello", null), "Hello\n");
});

test("letter stats separate Arabic and Latin letters", () => {
  assert.deepEqual(khowarLetterStats("سلام hello 123"), {
    letters: 9,
    arabic: 4,
    latin: 5,
  });
  assert.deepEqual(khowarLetterStats("123 !"), {
    letters: 0,
    arabic: 0,
    latin: 0,
  });
});

test("khowarTextError blocks empty, Latin-heavy and copied English", () => {
  assert.equal(khowarTextError("   ", "Hello"), "This field is required");
  assert.match(
    khowarTextError("hello world", "Hello world") ?? "",
    /Perso-Arabic/,
  );
  assert.match(
    khowarTextError("سلامسلام hey", "Hello") ?? "",
    /Latin letters/,
  );
  assert.match(
    khowarTextError("سلام", "سلام") ?? "",
    /still the English text/,
  );
  assert.equal(khowarTextError("سلام", "Hello"), null);
});

test("length warnings use the 0.3 and 4 boundaries", () => {
  const english = "a".repeat(100);
  assert.equal(khowarLengthWarning("ا".repeat(30), english, "text"), null);
  assert.match(
    khowarLengthWarning("ا".repeat(29), english, "text") ?? "",
    /much shorter/,
  );
  assert.match(
    khowarLengthWarning("ا".repeat(401), english, "text") ?? "",
    /much longer/,
  );
});

test("instruction schema applies the script rules and keeps optional input", () => {
  const english = {
    instruction: "Say hello.",
    input: null,
    response: "Hello!",
  };
  const parsed = instructionTranslationSchema(english).safeParse({
    khowar_instruction: "سلام",
    khowar_input: "",
    khowar_response: "سلام",
  });
  assert.equal(parsed.success, true);

  const invalid = validateInstructionTranslation(english, {
    khowar_instruction: "",
    khowar_input: "",
    khowar_response: "hello",
  });
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert.ok(invalid.errors.khowar_instruction);
    assert.ok(invalid.errors.khowar_response);
  }
});

test("conversation schema keeps the English turn count and roles", () => {
  const source = {
    turns: [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ],
  };

  const tooShort = conversationTranslationSchema(source).safeParse({
    turns: [{ role: "user", content: "سلام" }],
  });
  assert.equal(tooShort.success, false);

  const wrongRole = conversationTranslationSchema(source).safeParse({
    turns: [
      { role: "assistant", content: "سلام" },
      { role: "assistant", content: "سلام" },
    ],
  });
  assert.equal(wrongRole.success, false);

  const valid = validateConversationTranslation(source, {
    turns: [
      { role: "user", content: "سلام" },
      { role: "assistant", content: "سلام" },
    ],
  });
  assert.equal(valid.success, true);
});

test("plain text keeps paragraphs and enforces the 20 character floor", () => {
  assert.equal(
    normalizePlainText("  پہلا\n\n\n دوسرا  "),
    "پہلا\n\nدوسرا",
  );
  assert.equal(countCharacters("سلام"), 4);

  const short = plainTextSubmissionSchema.safeParse({
    title: "",
    khowar_text: "سلام",
    source_note: "",
    rights_confirmed: true,
  });
  assert.equal(short.success, false);

  const long = plainTextSubmissionSchema.safeParse({
    title: "  ",
    khowar_text: "سلام دنیا، یہ ایک لمبا متن ہے۔",
    source_note: "",
    rights_confirmed: true,
  });
  assert.equal(long.success, true);
  if (long.success) {
    assert.equal(long.data.title, null);
    assert.equal(long.data.source_note, null);
  }
});

test("plain text hash source collapses whitespace but keeps case", () => {
  assert.equal(plainTextHashSource("  اب\n\n Cd  "), "اب Cd");
});
