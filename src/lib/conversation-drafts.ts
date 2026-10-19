import {
  emptyConversationValues,
  hasConversationText,
  type ConversationSource,
  type ConversationTranslationValues,
} from "@/lib/khowar";

/**
 * Draft autosave for the conversations module, one localStorage key per item.
 * Only the Khowar text of each turn is stored; the roles always come from the
 * item, so a restored draft can never change the turn count or the order.
 * Drafts never leave the browser and are cleared on submit or skip.
 */

const KEY_PREFIX = "labeler.conversation-draft.";

function draftKey(itemId: string): string {
  return `${KEY_PREFIX}${itemId}`;
}

/**
 * The stored draft for an item, or null when there is nothing usable or the
 * saved turn count no longer matches the item.
 */
export function readConversationDraft(
  itemId: string,
  source: ConversationSource,
): ConversationTranslationValues | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(draftKey(itemId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== source.turns.length) {
      return null;
    }

    const values = emptyConversationValues(source);
    parsed.forEach((entry, index) => {
      if (typeof entry === "string") values.turns[index].content = entry;
    });

    return hasConversationText(values) ? values : null;
  } catch {
    return null;
  }
}

export function writeConversationDraft(
  itemId: string,
  values: ConversationTranslationValues,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      draftKey(itemId),
      JSON.stringify(values.turns.map((turn) => turn.content)),
    );
  } catch {
    // Storage can be full or blocked. Typing keeps working without a draft.
  }
}

export function clearConversationDraft(itemId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(draftKey(itemId));
  } catch {
    // Nothing to do: the next successful submit overwrites it anyway.
  }
}
