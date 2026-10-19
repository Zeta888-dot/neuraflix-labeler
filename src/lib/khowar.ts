import { z } from "zod";

/**
 * Khowar text rules from LABELER.md section 7. This module is imported by the
 * client workspace and by the server actions, so validation always runs twice.
 * Raw text is stored as typed: normalizeKhowar is used for checking, not for
 * writing to the database.
 */

/** Zero width non-joiner. The one format character Khowar text keeps. */
export const ZWNJ = "\u200C";

/* C0 controls except newline (U+000A), DEL, C1 controls and the BOM. ZWNJ is
   not a control character, so it survives this pass. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\uFEFF]/g;

/* Whitespace runs that are not newlines. */
const SPACE_RUNS = /[^\S\n]+/g;

const LETTER = /\p{L}/u;
const ARABIC_LETTER = /[\u0600-\u06FF\u0750-\u077F]/;
const LATIN_LETTER = /\p{Script=Latin}/u;

/** NFC, control characters removed, spaces collapsed, trimmed. */
export function normalizeKhowar(value: string): string {
  return value
    .normalize("NFC")
    .replace(CONTROL_CHARS, "")
    .replace(SPACE_RUNS, " ")
    .trim();
}

/**
 * Stricter pass used for comparing against the English and for hashing:
 * NFC, every whitespace run collapsed to one space, trimmed. Mirrored by the
 * english_hash backfill in supabase/migrations/0002_instructions.sql.
 */
export function normalizeWhitespace(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The string hashed into instruction_items.english_hash. */
export function englishHashSource(
  instruction: string,
  input?: string | null,
): string {
  return `${normalizeWhitespace(instruction)}\n${normalizeWhitespace(input ?? "")}`;
}

/** The English side of one instruction item. */
export type EnglishSource = {
  instruction: string;
  input: string | null;
  response: string;
};

export const khowarFieldNames = [
  "khowar_instruction",
  "khowar_input",
  "khowar_response",
] as const;

export type KhowarFieldName = (typeof khowarFieldNames)[number];

export type KhowarFieldErrors = Partial<Record<KhowarFieldName, string>>;

export type InstructionTranslationValues = {
  khowar_instruction: string;
  khowar_input: string;
  khowar_response: string;
};

export function emptyInstructionValues(): InstructionTranslationValues {
  return { khowar_instruction: "", khowar_input: "", khowar_response: "" };
}

export function isKhowarFieldName(value: unknown): value is KhowarFieldName {
  return (
    typeof value === "string" &&
    (khowarFieldNames as readonly string[]).includes(value)
  );
}

export type KhowarLetterStats = {
  letters: number;
  arabic: number;
  latin: number;
};

/** Letter counts used by the ratio rules. Digits and punctuation do not count. */
export function khowarLetterStats(value: string): KhowarLetterStats {
  let letters = 0;
  let arabic = 0;
  let latin = 0;

  for (const character of value) {
    if (!LETTER.test(character)) continue;
    letters += 1;
    if (ARABIC_LETTER.test(character)) {
      arabic += 1;
    } else if (LATIN_LETTER.test(character)) {
      latin += 1;
    }
  }

  return { letters, arabic, latin };
}

/**
 * Blocking rules: empty fields, at least 60 percent Arabic-script letters,
 * Latin letters under 20 percent of letters, and not identical to the English.
 * Returns null when the text passes.
 */
export function khowarTextError(value: string, source: string): string | null {
  const text = normalizeKhowar(value);
  if (text === "") return "This field is required";

  const stats = khowarLetterStats(text);
  if (stats.letters === 0 || stats.arabic / stats.letters < 0.6) {
    return "Write this in Perso-Arabic script. At least 60 percent of the letters must be Khowar letters.";
  }
  if (stats.latin / stats.letters > 0.2) {
    return "Too many Latin letters. Keep Latin letters under 20 percent of the text.";
  }

  const english = normalizeWhitespace(source);
  if (english !== "" && normalizeWhitespace(text).toLowerCase() === english.toLowerCase()) {
    return "This is still the English text. Translate it into Khowar.";
  }

  return null;
}

export const LENGTH_RATIO_MIN = 0.3;
export const LENGTH_RATIO_MAX = 4;

/**
 * Non-blocking rule: length ratio against the English. The contributor can
 * accept the warning and submit anyway.
 */
export function khowarLengthWarning(
  value: string,
  source: string,
  label: string,
): string | null {
  const text = normalizeKhowar(value);
  const english = normalizeKhowar(source);
  if (text === "" || english === "") return null;

  const ratio = text.length / english.length;
  if (ratio < LENGTH_RATIO_MIN) {
    return `The Khowar ${label} is much shorter than the English one. Check that nothing is missing.`;
  }
  if (ratio > LENGTH_RATIO_MAX) {
    return `The Khowar ${label} is much longer than the English one. Check that no extra text got in.`;
  }
  return null;
}

const fieldLabels: Record<KhowarFieldName, string> = {
  khowar_instruction: "instruction",
  khowar_input: "input",
  khowar_response: "response",
};

/** The English source text one field is translated from. */
function fieldSource(
  english: EnglishSource,
  field: KhowarFieldName,
): string | null {
  if (field === "khowar_instruction") return english.instruction;
  if (field === "khowar_response") return english.response;
  return english.input && english.input.trim() !== "" ? english.input : null;
}

function textField(source: string) {
  return z.string().superRefine((value, ctx) => {
    const error = khowarTextError(value, source);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });
}

/**
 * The instruction translation schema: required fields, script rules, no copy
 * of the English. The length ratio stays out of the schema on purpose, it is a
 * warning, not a blocking error.
 */
export function instructionTranslationSchema(english: EnglishSource) {
  const inputSource = fieldSource(english, "khowar_input");
  return z.object({
    khowar_instruction: textField(english.instruction),
    khowar_input: inputSource ? textField(inputSource) : z.string(),
    khowar_response: textField(english.response),
  });
}

/** Per-field length-ratio warnings for the fields the English item has. */
export function instructionFieldWarnings(
  english: EnglishSource,
  values: InstructionTranslationValues,
): KhowarFieldErrors {
  const warnings: KhowarFieldErrors = {};
  for (const field of khowarFieldNames) {
    const source = fieldSource(english, field);
    if (!source) continue;
    const warning = khowarLengthWarning(values[field], source, fieldLabels[field]);
    if (warning) warnings[field] = warning;
  }
  return warnings;
}

export function instructionWarnings(
  english: EnglishSource,
  values: InstructionTranslationValues,
): string[] {
  return Object.values(instructionFieldWarnings(english, values)).filter(
    (warning): warning is string => typeof warning === "string",
  );
}

export type InstructionValidation =
  | {
      success: true;
      data: InstructionTranslationValues;
      warnings: string[];
    }
  | { success: false; errors: KhowarFieldErrors; warnings: string[] };

/** One call the client and the server both use. */
export function validateInstructionTranslation(
  english: EnglishSource,
  values: InstructionTranslationValues,
): InstructionValidation {
  const parsed = instructionTranslationSchema(english).safeParse(values);
  const warnings = instructionWarnings(english, values);

  if (!parsed.success) {
    const errors: KhowarFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (isKhowarFieldName(field) && !errors[field]) errors[field] = issue.message;
    }
    return { success: false, errors, warnings };
  }

  return { success: true, data: parsed.data, warnings };
}

/* ---------------------------------------------------------------------------
 * Conversations (Phase L2). The English item is a list of turns and each turn
 * gets its own Khowar translation, so the same text rules apply per turn and
 * the structure rules keep the turns aligned with the English item.
 * ------------------------------------------------------------------------ */

export const conversationRoles = ["system", "user", "assistant"] as const;

export type ConversationRole = (typeof conversationRoles)[number];

export type ConversationTurn = {
  role: ConversationRole;
  content: string;
};

/** The English side of one conversation item, as stored in the jsonb payload. */
export type ConversationSource = { turns: ConversationTurn[] };

export function isConversationRole(value: unknown): value is ConversationRole {
  return (
    typeof value === "string" &&
    (conversationRoles as readonly string[]).includes(value)
  );
}

/** Per turn limit, mirrored by submit_conversation_translation in 0004. */
export const MAX_TURN_CHARS = 4000;

/**
 * The string hashed into conversation_items.english_hash: role and content per
 * turn, joined with a blank line. Mirrored by the backfill in
 * supabase/migrations/0004_conversations.sql.
 */
export function conversationHashSource(turns: ConversationTurn[]): string {
  return turns
    .map(
      (turn) =>
        `${normalizeWhitespace(turn.role)}\n${normalizeWhitespace(turn.content)}`,
    )
    .join("\n\n");
}

/** One Khowar field per English turn, in the English order. */
export type ConversationTranslationValues = {
  turns: ConversationTurn[];
};

export function emptyConversationValues(
  source: ConversationSource,
): ConversationTranslationValues {
  return {
    turns: source.turns.map((turn) => ({ role: turn.role, content: "" })),
  };
}

export function hasConversationText(
  values: ConversationTranslationValues,
): boolean {
  return values.turns.some((turn) => turn.content.trim() !== "");
}

/** Index of the first turn with no text yet, or null when all are filled. */
export function firstEmptyTurn(
  values: ConversationTranslationValues,
): number | null {
  const index = values.turns.findIndex((turn) => turn.content.trim() === "");
  return index === -1 ? null : index;
}

/** Messages keyed by turn index, plus one slot for a whole-conversation error. */
export type ConversationFieldErrors = {
  form: string | null;
  turns: Record<number, string>;
};

const conversationTurnSchema = z.object({
  role: z.enum(conversationRoles),
  content: z
    .string()
    .max(MAX_TURN_CHARS, `Keep each turn under ${MAX_TURN_CHARS} characters`),
});

/**
 * The conversation translation schema: the turns must keep the English count
 * and order, and every content follows the same script rules as the instruction
 * fields. The length ratio stays a warning, not a blocking error.
 */
export function conversationTranslationSchema(source: ConversationSource) {
  return z
    .object({ turns: z.array(conversationTurnSchema) })
    .superRefine((values, ctx) => {
      if (values.turns.length !== source.turns.length) {
        ctx.addIssue({
          code: "custom",
          path: ["turns"],
          message: `This conversation has ${source.turns.length} turns. Reload the item before submitting.`,
        });
        return;
      }

      values.turns.forEach((turn, index) => {
        const english = source.turns[index];
        if (turn.role !== english.role) {
          ctx.addIssue({
            code: "custom",
            path: ["turns", index, "content"],
            message: "The turn order changed. Reload the item before submitting.",
          });
          return;
        }

        const error = khowarTextError(turn.content, english.content);
        if (error) {
          ctx.addIssue({ code: "custom", path: ["turns", index, "content"], message: error });
        }
      });
    });
}

/** Per-turn length-ratio warnings, keyed by turn index. */
export function conversationTurnWarnings(
  source: ConversationSource,
  values: ConversationTranslationValues,
): Record<number, string> {
  const warnings: Record<number, string> = {};

  values.turns.forEach((turn, index) => {
    const english = source.turns[index];
    if (!english) return;
    const warning = khowarLengthWarning(
      turn.content,
      english.content,
      `text of turn ${index + 1}`,
    );
    if (warning) warnings[index] = warning;
  });

  return warnings;
}

export function conversationWarnings(
  source: ConversationSource,
  values: ConversationTranslationValues,
): string[] {
  return Object.values(conversationTurnWarnings(source, values));
}

export type ConversationValidation =
  | {
      success: true;
      data: ConversationTranslationValues;
      warnings: string[];
    }
  | { success: false; errors: ConversationFieldErrors; warnings: string[] };

/** One call the client and the server both use. */
export function validateConversationTranslation(
  source: ConversationSource,
  values: ConversationTranslationValues,
): ConversationValidation {
  const parsed = conversationTranslationSchema(source).safeParse(values);
  const warnings = conversationWarnings(source, values);

  if (!parsed.success) {
    const errors: ConversationFieldErrors = { form: null, turns: {} };

    for (const issue of parsed.error.issues) {
      const index = issue.path[0] === "turns" ? issue.path[1] : undefined;
      if (typeof index === "number") {
        if (!errors.turns[index]) errors.turns[index] = issue.message;
      } else if (!errors.form) {
        errors.form = issue.message;
      }
    }

    return { success: false, errors, warnings };
  }

  return { success: true, data: parsed.data, warnings };
}
