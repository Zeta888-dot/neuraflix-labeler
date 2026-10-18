import {
  emptyInstructionValues,
  type InstructionTranslationValues,
} from "@/lib/khowar";

/**
 * Draft autosave for the instructions module, one localStorage key per item.
 * Drafts never leave the browser and are cleared on submit or skip.
 */

const KEY_PREFIX = "labeler.instruction-draft.";

function draftKey(itemId: string): string {
  return `${KEY_PREFIX}${itemId}`;
}

/** The stored draft for an item, or null when there is nothing usable. */
export function readInstructionDraft(
  itemId: string,
): InstructionTranslationValues | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(draftKey(itemId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;

    const values = emptyInstructionValues();
    for (const field of [
      "khowar_instruction",
      "khowar_input",
      "khowar_response",
    ] as const) {
      const value = record[field];
      if (typeof value === "string") values[field] = value;
    }

    return hasInstructionText(values) ? values : null;
  } catch {
    return null;
  }
}

export function writeInstructionDraft(
  itemId: string,
  values: InstructionTranslationValues,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(draftKey(itemId), JSON.stringify(values));
  } catch {
    // Storage can be full or blocked. Typing keeps working without a draft.
  }
}

export function clearInstructionDraft(itemId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftKey(itemId));
  } catch {
    // Nothing to do: the next successful submit overwrites it anyway.
  }
}

export function hasInstructionText(
  values: InstructionTranslationValues,
): boolean {
  return (
    values.khowar_instruction.trim() !== "" ||
    values.khowar_input.trim() !== "" ||
    values.khowar_response.trim() !== ""
  );
}
