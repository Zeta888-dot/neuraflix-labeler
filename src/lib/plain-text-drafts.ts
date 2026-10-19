/**
 * Draft autosave for the plain text form. Only text, title and source are
 * stored; the rights confirmation must be given again after a reload. Drafts
 * never leave the browser and are cleared on submit or by the Clear draft
 * button.
 */

const DRAFT_KEY = "labeler.plain-text-draft.v1";

export type PlainTextDraft = {
  text: string;
  title: string;
  source: string;
};

export function readPlainTextDraft(): PlainTextDraft | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;

    const draft: PlainTextDraft = {
      text: typeof record.text === "string" ? record.text : "",
      title: typeof record.title === "string" ? record.title : "",
      source: typeof record.source === "string" ? record.source : "",
    };

    if (
      draft.text.trim() === "" &&
      draft.title.trim() === "" &&
      draft.source.trim() === ""
    ) {
      return null;
    }

    return draft;
  } catch {
    return null;
  }
}

export function writePlainTextDraft(draft: PlainTextDraft): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage can be full or blocked. Typing keeps working without a draft.
  }
}

export function clearPlainTextDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to do: the next submit clears it again.
  }
}
