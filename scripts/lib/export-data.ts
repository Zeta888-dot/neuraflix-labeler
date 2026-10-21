import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ConversationExportRecord,
  ExportInput,
  InstructionExportRecord,
  TextExportRecord,
} from "./export-core";
import { fetchApprovedOcrLines } from "./ocr-query";

/**
 * Live reads for the export. Every query filters on status = approved, and the
 * pure builders filter again. No content is printed or logged.
 */

const PAGE_SIZE = 1000;

type QueryResult = {
  data: unknown;
  error: { message: string } | null;
};

async function collect<T>(
  name: string,
  page: (from: number, to: number) => PromiseLike<QueryResult>,
  parse: (value: unknown) => T | null,
): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) {
      throw new Error(`Could not read ${name}: ${error.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error(`Could not read ${name}: unexpected response`);
    }

    const batch: unknown[] = data;
    for (const entry of batch) {
      const parsed = parse(entry);
      if (!parsed) {
        throw new Error(`An approved ${name} row has unusable database fields`);
      }
      rows.push(parsed);
    }

    if (batch.length < PAGE_SIZE) break;
  }

  return rows;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function joinedObject(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) value = value[0];
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function parseInstruction(value: unknown): InstructionExportRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const item = joinedObject(row.instruction_items);

  const id = optionalString(row.id);
  const itemId = optionalString(row.item_id);
  const status = optionalString(row.status);
  if (!id || !itemId || !status || !item || item.english === undefined) {
    return null;
  }

  return {
    id,
    itemId,
    contributorId: optionalString(row.contributor_id),
    status,
    khowarInstruction: stringValue(row.khowar_instruction),
    khowarInput: stringValue(row.khowar_input),
    khowarResponse: stringValue(row.khowar_response),
    english: item.english,
  };
}

function parseConversation(value: unknown): ConversationExportRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const item = joinedObject(row.conversation_items);

  const id = optionalString(row.id);
  const itemId = optionalString(row.item_id);
  const status = optionalString(row.status);
  if (!id || !itemId || !status || !item || item.english === undefined) {
    return null;
  }

  return {
    id,
    itemId,
    contributorId: optionalString(row.contributor_id),
    status,
    turns: row.turns,
    english: item.english,
  };
}

function parseText(value: unknown): TextExportRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const id = optionalString(row.id);
  const status = optionalString(row.status);
  if (!id || !status || typeof row.khowar_text !== "string") return null;

  return {
    id,
    contributorId: optionalString(row.contributor_id),
    status,
    text: row.khowar_text,
  };
}

export async function fetchExportInput(
  supabase: SupabaseClient,
): Promise<ExportInput> {
  const [instructions, conversations, texts, ocrLines] = await Promise.all([
    collect(
      "instruction translations",
      (from, to) =>
        supabase
          .from("instruction_translations")
          .select(
            "id, item_id, contributor_id, status, khowar_instruction, khowar_input, khowar_response, instruction_items!inner(id, english)",
          )
          .eq("status", "approved")
          .order("id", { ascending: true })
          .range(from, to),
      parseInstruction,
    ),
    collect(
      "conversation translations",
      (from, to) =>
        supabase
          .from("conversation_translations")
          .select(
            "id, item_id, contributor_id, status, turns, conversation_items!inner(id, english)",
          )
          .eq("status", "approved")
          .order("id", { ascending: true })
          .range(from, to),
      parseConversation,
    ),
    collect(
      "plain text submissions",
      (from, to) =>
        supabase
          .from("text_submissions")
          .select("id, contributor_id, status, khowar_text")
          .eq("status", "approved")
          .order("id", { ascending: true })
          .range(from, to),
      parseText,
    ),
    fetchApprovedOcrLines(supabase, { includePurged: true }),
  ]);

  return { instructions, conversations, texts, ocrLines };
}
