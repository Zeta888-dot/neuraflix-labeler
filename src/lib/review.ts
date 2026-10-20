import { z } from "zod";
import {
  MAX_TURN_CHARS,
  conversationRoles,
  conversationTranslationSchema,
  countCharacters,
  instructionTranslationSchema,
  khowarLengthWarning,
  khowarLetterStats,
  normalizeKhowar,
  normalizeWhitespace,
  plainTextSubmissionSchema,
  type ConversationSource,
  type ConversationTurn,
  type EnglishSource,
  type InstructionTranslationValues,
} from "./khowar";
import { validateLabel } from "./ocr/labels";
import { parseEnglishSource, type InstructionItem } from "./instructions";
import { parseConversationSource } from "./conversations";

/**
 * Pure review helpers. Imported by the review page, the server actions and the
 * node:test suite, so this file must stay free of Supabase, React and Node
 * imports. The decision schemas validate twice: here in the browser and again
 * in the server action.
 */

export const REVIEW_KINDS = [
  "instruction",
  "conversation",
  "text",
  "ocr",
] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const reviewKindLabels: Record<ReviewKind, string> = {
  instruction: "Instructions",
  conversation: "Conversations",
  text: "Plain text",
  ocr: "OCR pages",
};

export const reviewKindSingular: Record<ReviewKind, string> = {
  instruction: "Instruction",
  conversation: "Conversation",
  text: "Plain text",
  ocr: "OCR page",
};

export function isReviewKind(value: unknown): value is ReviewKind {
  return (
    typeof value === "string" &&
    (REVIEW_KINDS as readonly string[]).includes(value)
  );
}

export type ReviewCounts = Record<ReviewKind, number>;

export const emptyReviewCounts: ReviewCounts = {
  instruction: 0,
  conversation: 0,
  text: 0,
  ocr: 0,
};

export type ReviewInstructionItem = {
  kind: "instruction";
  id: string;
  source: string | null;
  createdAt: string;
  createdLabel: string;
  english: EnglishSource;
  values: InstructionTranslationValues;
};

export type ReviewConversationItem = {
  kind: "conversation";
  id: string;
  source: string | null;
  createdAt: string;
  createdLabel: string;
  english: ConversationSource;
  turns: ConversationTurn[];
};

export type ReviewTextItem = {
  kind: "text";
  id: string;
  createdAt: string;
  createdLabel: string;
  title: string | null;
  sourceNote: string | null;
  text: string;
};

export type ReviewOcrLine = {
  id: string;
  idx: number;
  label: string;
  width: number;
  height: number;
  /** A one hour signed URL, or null when signing failed. */
  imageUrl: string | null;
};

export type ReviewOcrItem = {
  kind: "ocr";
  id: string;
  createdAt: string;
  createdLabel: string;
  pageLabel: string | null;
  lineCount: number;
  lines: ReviewOcrLine[];
  imagesError: boolean;
};

export type ReviewItem =
  | ReviewInstructionItem
  | ReviewConversationItem
  | ReviewTextItem
  | ReviewOcrItem;

export type ReviewQueueOk = {
  status: "ok";
  kind: ReviewKind;
  counts: ReviewCounts;
  allowSelfReview: boolean;
  reviewsDone: number | null;
  item: ReviewItem | null;
};

export type ReviewQueue =
  | ReviewQueueOk
  | { status: "error"; kind: ReviewKind; message: string };

export type ReviewOcrLineInput = {
  idx: number;
  label: string;
  reject: boolean;
};

export type ReviewDecision = "approve" | "reject";

export type ReviewDecisionInput =
  | {
      kind: "instruction";
      translationId: string;
      decision: ReviewDecision;
      note: string;
      english: EnglishSource;
      values: InstructionTranslationValues;
    }
  | {
      kind: "conversation";
      translationId: string;
      decision: ReviewDecision;
      note: string;
      englishTurns: ConversationTurn[];
      turns: ConversationTurn[];
    }
  | {
      kind: "text";
      submissionId: string;
      decision: ReviewDecision;
      note: string;
      text: string;
    }
  | {
      kind: "ocr";
      pageId: string;
      decision: ReviewDecision;
      note: string;
      lines: ReviewOcrLineInput[];
    };

export type ReviewDecisionResult =
  | { status: "decided"; queue: ReviewQueue; message: string }
  | {
      status: "blocked";
      message: string;
      /** Present when the item vanished, so the next one can be shown. */
      queue?: ReviewQueue;
    };

export type FeedbackItem = {
  kind: ReviewKind;
  id: string;
  preview: string;
  status: string;
  reviewerEdited: boolean;
  reviewNote: string | null;
  reviewedAt: string;
  reviewedLabel: string;
  kindLabel: string;
};

const reviewDateFormatter = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Deterministic on server and client: always English, always UTC. */
export function reviewDateLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return reviewDateFormatter.format(date);
}

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function toNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/* ---------------------------------------------------------------------------
 * Parsers for the RPC rows. PostgREST returns snake_case with the out_ prefix.
 * ------------------------------------------------------------------------ */

export function parseReviewCounts(
  rows: unknown,
): { counts: ReviewCounts; allowSelfReview: boolean } | null {
  if (!Array.isArray(rows)) return null;

  const counts: ReviewCounts = { ...emptyReviewCounts };
  const seen = new Set<ReviewKind>();
  let allowSelfReview: boolean | null = null;

  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (!isReviewKind(row.out_kind)) return null;

    const count = toNumber(row.out_submitted);
    if (count === null || count < 0) return null;

    counts[row.out_kind] = Math.trunc(count);
    seen.add(row.out_kind);

    if (typeof row.out_allow_self_review === "boolean") {
      allowSelfReview = row.out_allow_self_review;
    }
  }

  if (seen.size !== REVIEW_KINDS.length || allowSelfReview === null) {
    return null;
  }

  return { counts, allowSelfReview };
}

export function parseReviewItem(row: unknown): ReviewItem | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (!isReviewKind(value.out_kind)) return null;

  const id = trimmedString(value.out_id);
  const createdAt = trimmedString(value.out_created_at);
  if (!id || !createdAt) return null;

  const createdLabel = reviewDateLabel(createdAt);

  if (value.out_kind === "instruction") {
    const english = parseEnglishSource(value.out_english);
    const instruction = trimmedString(value.out_khowar_instruction);
    if (!english || !instruction) return null;

    return {
      kind: "instruction",
      id,
      source: trimmedString(value.out_source),
      createdAt,
      createdLabel,
      english,
      values: {
        khowar_instruction: String(value.out_khowar_instruction),
        khowar_input:
          typeof value.out_khowar_input === "string"
            ? value.out_khowar_input
            : "",
        khowar_response:
          typeof value.out_khowar_response === "string"
            ? value.out_khowar_response
            : "",
      },
    };
  }

  if (value.out_kind === "conversation") {
    const english = parseConversationSource(value.out_english);
    const translated = parseConversationSource({ turns: value.out_turns });
    if (!english || !translated) return null;

    return {
      kind: "conversation",
      id,
      source: trimmedString(value.out_source),
      createdAt,
      createdLabel,
      english,
      turns: translated.turns,
    };
  }

  if (value.out_kind === "text") {
    const text =
      typeof value.out_khowar_text === "string" ? value.out_khowar_text : null;
    if (text === null) return null;

    return {
      kind: "text",
      id,
      createdAt,
      createdLabel,
      title: trimmedString(value.out_title),
      sourceNote: trimmedString(value.out_source_note),
      text,
    };
  }

  const lineCount = toNumber(value.out_line_count);
  if (lineCount === null || lineCount < 0) return null;

  return {
    kind: "ocr",
    id,
    createdAt,
    createdLabel,
    pageLabel: trimmedString(value.out_page_label),
    lineCount: Math.trunc(lineCount),
    lines: [],
    imagesError: false,
  };
}

export function parseFeedbackRows(rows: unknown): FeedbackItem[] | null {
  if (!Array.isArray(rows)) return null;

  const items: FeedbackItem[] = [];
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    if (!isReviewKind(row.out_kind)) return null;

    const id = trimmedString(row.out_id);
    const reviewedAt = trimmedString(row.out_reviewed_at);
    if (!id || !reviewedAt) continue;

    items.push({
      kind: row.out_kind,
      id,
      preview: typeof row.out_preview === "string" ? row.out_preview : "",
      status: typeof row.out_status === "string" ? row.out_status : "",
      reviewerEdited: row.out_reviewer_edited === true,
      reviewNote: trimmedString(row.out_review_note),
      reviewedAt,
      reviewedLabel: reviewDateLabel(reviewedAt),
      kindLabel: reviewKindSingular[row.out_kind],
    });
  }

  return items;
}

/* ---------------------------------------------------------------------------
 * Decision payload validation
 * ------------------------------------------------------------------------ */

const decisionEnum = z.enum(["approve", "reject"]);

const noteField = z
  .string()
  .max(2000, "Keep the note under 2000 characters.");

function addDecisionIssues(
  decision: ReviewDecision,
  note: string,
  ctx: z.RefinementCtx,
): void {
  if (decision === "reject" && note.trim().length < 3) {
    ctx.addIssue({
      code: "custom",
      path: ["note"],
      message: "Add a note of at least 3 characters before rejecting.",
    });
  }
}

/** Decision and note only. Used by tests and by the reject dialog. */
export const reviewDecisionSchema = z
  .object({ decision: decisionEnum, note: noteField })
  .superRefine((value, ctx) => addDecisionIssues(value.decision, value.note, ctx));

const englishSourceSchema = z.object({
  instruction: z.string().min(1).max(8000),
  input: z.string().max(8000).nullable(),
  response: z.string().min(1).max(8000),
});

const instructionValuesSchema = z.object({
  khowar_instruction: z.string(),
  khowar_input: z.string(),
  khowar_response: z.string(),
});

export function reviewInstructionSchema() {
  return z
    .object({
      kind: z.literal("instruction"),
      translationId: z.uuid(),
      decision: decisionEnum,
      note: noteField,
      english: englishSourceSchema,
      values: instructionValuesSchema,
    })
    .superRefine((value, ctx) => {
      addDecisionIssues(value.decision, value.note, ctx);
      if (value.decision !== "approve") return;

      const parsed = instructionTranslationSchema(value.english).safeParse(
        value.values,
      );
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["values", ...issue.path],
            message: issue.message,
          });
        }
      }
    });
}

const turnsSchema = z
  .array(
    z.object({
      role: z.enum(conversationRoles),
      content: z
        .string()
        .max(MAX_TURN_CHARS, `Keep each turn under ${MAX_TURN_CHARS} characters`),
    }),
  )
  .min(1)
  .max(20);

const sourceTurnsSchema = z
  .array(
    z.object({
      role: z.enum(conversationRoles),
      content: z.string().min(1).max(MAX_TURN_CHARS),
    }),
  )
  .min(1)
  .max(20);

export function reviewConversationSchema() {
  return z
    .object({
      kind: z.literal("conversation"),
      translationId: z.uuid(),
      decision: decisionEnum,
      note: noteField,
      englishTurns: sourceTurnsSchema,
      turns: turnsSchema,
    })
    .superRefine((value, ctx) => {
      addDecisionIssues(value.decision, value.note, ctx);
      if (value.decision !== "approve") return;

      const parsed = conversationTranslationSchema({
        turns: value.englishTurns,
      }).safeParse({ turns: value.turns });

      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: "custom",
            path: ["turns", ...issue.path],
            message: issue.message,
          });
        }
      }
    });
}

export function reviewTextSchema() {
  return z
    .object({
      kind: z.literal("text"),
      submissionId: z.uuid(),
      decision: decisionEnum,
      note: noteField,
      text: z.string().max(20000),
    })
    .superRefine((value, ctx) => {
      addDecisionIssues(value.decision, value.note, ctx);
      if (value.decision !== "approve") return;

      const parsed = plainTextSubmissionSchema.safeParse({
        title: "",
        khowar_text: value.text,
        source_note: "",
        rights_confirmed: true,
      });

      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (issue.path[0] !== "khowar_text") continue;
          ctx.addIssue({
            code: "custom",
            path: ["text"],
            message: issue.message,
          });
        }
      }
    });
}

const ocrLineSchema = z.object({
  idx: z.number().int().min(1).max(40),
  label: z.string().max(2000),
  reject: z.boolean(),
});

export function reviewOcrSchema() {
  return z
    .object({
      kind: z.literal("ocr"),
      pageId: z.uuid(),
      decision: decisionEnum,
      note: noteField,
      lines: z.array(ocrLineSchema).max(40),
    })
    .superRefine((value, ctx) => {
      addDecisionIssues(value.decision, value.note, ctx);
      if (value.decision !== "approve") return;

      const seen = new Set<number>();
      let approved = 0;

      value.lines.forEach((line, index) => {
        if (seen.has(line.idx)) {
          ctx.addIssue({
            code: "custom",
            path: ["lines", index, "idx"],
            message: "Each line number may appear once.",
          });
        }
        seen.add(line.idx);

        if (line.reject) return;
        approved += 1;

        const result = validateLabel(line.label);
        if (!result.ok) {
          ctx.addIssue({
            code: "custom",
            path: ["lines", index, "label"],
            message: result.error,
          });
        }
      });

      if (approved < 1) {
        ctx.addIssue({
          code: "custom",
          path: ["lines"],
          message: "Keep at least one line before approving the page.",
        });
      }
    });
}

/* ---------------------------------------------------------------------------
 * Non-blocking auto checks for the reviewer
 * ------------------------------------------------------------------------ */

export type AutoCheck = {
  id: string;
  message: string;
};

const REPEATED_CHARACTERS = /(\p{L})\1{3,}/u;

function autoChecksForText(
  label: string,
  text: string,
  english: string | null,
  allowDigitsOnly: boolean,
): AutoCheck[] {
  const normalized = normalizeKhowar(text);
  if (normalized === "") return [];

  const stats = khowarLetterStats(normalized);
  const checks: AutoCheck[] = [];
  const add = (id: string, message: string) => {
    checks.push({ id: `${label}:${id}`, message: `${label}: ${message}` });
  };

  if (!allowDigitsOnly && stats.letters > 0 && stats.arabic / stats.letters < 0.6) {
    add("low-arabic", "low Perso-Arabic letter ratio.");
  }
  if (!allowDigitsOnly && stats.letters === 0) {
    add("no-arabic", "no Arabic-script letters.");
  }
  if (stats.letters > 0 && stats.latin / stats.letters > 0.2) {
    add("high-latin", "too many Latin letters.");
  }

  if (english && normalizeWhitespace(english) !== "") {
    if (
      normalizeWhitespace(normalized).toLowerCase() ===
      normalizeWhitespace(english).toLowerCase()
    ) {
      add("same-as-english", "this is still the English text.");
    }

    const ratioWarning = khowarLengthWarning(
      normalized,
      english,
      label.toLowerCase(),
    );
    if (ratioWarning) add("length-ratio", ratioWarning);
  }

  if (stats.letters > 0 && stats.letters < 5) {
    add("very-short", "very short.");
  }

  if (REPEATED_CHARACTERS.test(normalized)) {
    add("repeated-characters", "repeated characters look suspicious.");
  }

  return checks;
}

/**
 * Non-blocking flags for the reviewer. `content` depends on the kind:
 * instruction values, conversation turns, plain text, or one OCR label.
 */
export function buildAutoChecks(
  kind: ReviewKind,
  content: unknown,
  english?: unknown,
): AutoCheck[] {
  const checks: AutoCheck[] = [];

  if (kind === "instruction") {
    const values = content as Partial<InstructionTranslationValues> | null;
    const source = english as EnglishSource | null;
    if (!values || typeof values !== "object") return [];

    const fields: Array<{
      label: string;
      value: string;
      source: string | null;
    }> = [
      {
        label: "Instruction",
        value: values.khowar_instruction ?? "",
        source: source?.instruction ?? null,
      },
    ];

    if (source?.input && source.input.trim() !== "") {
      fields.push({
        label: "Input",
        value: values.khowar_input ?? "",
        source: source.input,
      });
    }

    fields.push({
      label: "Response",
      value: values.khowar_response ?? "",
      source: source?.response ?? null,
    });

    for (const field of fields) {
      checks.push(
        ...autoChecksForText(field.label, field.value, field.source, false),
      );
    }
  } else if (kind === "conversation") {
    const turns = content as ConversationTurn[] | null;
    const source = english as ConversationSource | null;
    if (!Array.isArray(turns)) return [];

    turns.forEach((turn, index) => {
      const englishTurn = source?.turns[index];
      const label = `Turn ${index + 1} (${turn.role})`;
      checks.push(
        ...autoChecksForText(
          label,
          turn.content,
          englishTurn?.content ?? null,
          false,
        ),
      );
    });
  } else if (kind === "text") {
    checks.push(
      ...autoChecksForText(
        "Text",
        typeof content === "string" ? content : "",
        null,
        false,
      ),
    );
  } else {
    checks.push(
      ...autoChecksForText(
        "Label",
        typeof content === "string" ? content : "",
        null,
        true,
      ),
    );
  }

  const unique = new Map<string, AutoCheck>();
  for (const check of checks) unique.set(check.id, check);
  return Array.from(unique.values());
}

/** True when the reviewer changed the submitted values. */
export function instructionValuesChanged(
  item: ReviewInstructionItem,
  values: InstructionTranslationValues,
): boolean {
  return (
    values.khowar_instruction !== item.values.khowar_instruction ||
    values.khowar_input !== item.values.khowar_input ||
    values.khowar_response !== item.values.khowar_response
  );
}

export function conversationTurnsChanged(
  item: ReviewConversationItem,
  turns: ConversationTurn[],
): boolean {
  if (turns.length !== item.turns.length) return true;
  return turns.some(
    (turn, index) =>
      turn.role !== item.turns[index]?.role ||
      turn.content !== item.turns[index]?.content,
  );
}

export function countCharactersIn(value: string): number {
  return countCharacters(value);
}

/** Re-exported so the item cards share one English parser. */
export type { InstructionItem };
