import {
  clampSegParams,
  type LineBox,
  type SegParams,
} from "./segment-core";
import type { LineDraft } from "./labels";

/**
 * One OCR draft per signed-in user, kept in IndexedDB in this browser only.
 * The database and store are fixed; the record key is scoped by the user id,
 * so another account on the same machine never sees this draft.
 */

export const OCR_DRAFT_SCHEMA_VERSION = 1;
export const OCR_DRAFT_DB = "neuraflix-labeler";
export const OCR_DRAFT_STORE = "ocr-drafts";
export const OCR_DRAFT_KEY_PREFIX = "ocr-draft:";

const DB_VERSION = 1;

export function ocrDraftKey(userId: string): string {
  return `${OCR_DRAFT_KEY_PREFIX}${userId}`;
}

export type OcrDraft = {
  schemaVersion: typeof OCR_DRAFT_SCHEMA_VERSION;
  updatedAt: number;
  /** The original upload. It never leaves this browser. */
  file: Blob;
  fileName: string;
  params: SegParams;
  /** Edited boxes, kept alongside the line drafts. */
  boxes: LineBox[];
  lines: LineDraft[];
  currentLine: number;
  pageLabel: string;
  rightsConfirmed: boolean;
};

export type OcrDraftInput = Omit<OcrDraft, "schemaVersion" | "updatedAt">;

export class DraftStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBox(value: unknown): value is LineBox {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(isFiniteNumber)
  );
}

function isLineDraft(value: unknown): value is LineDraft {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id !== "" &&
    isBox(value.box) &&
    typeof value.label === "string" &&
    (value.status === "empty" ||
      value.status === "labeled" ||
      value.status === "unreadable")
  );
}

function parseDraft(raw: unknown): OcrDraft | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== OCR_DRAFT_SCHEMA_VERSION) return null;
  if (!(raw.file instanceof Blob)) return null;
  if (typeof raw.fileName !== "string") return null;
  if (!isFiniteNumber(raw.updatedAt)) return null;
  if (!isRecord(raw.params)) return null;
  if (!Array.isArray(raw.boxes) || !raw.boxes.every(isBox)) return null;
  if (!Array.isArray(raw.lines) || !raw.lines.every(isLineDraft)) return null;
  if (raw.boxes.length !== raw.lines.length) return null;
  if (!isFiniteNumber(raw.currentLine)) return null;
  if (typeof raw.pageLabel !== "string") return null;
  if (typeof raw.rightsConfirmed !== "boolean") return null;

  return {
    schemaVersion: OCR_DRAFT_SCHEMA_VERSION,
    updatedAt: raw.updatedAt,
    file: raw.file,
    fileName: raw.fileName,
    params: clampSegParams(raw.params as Partial<SegParams>),
    boxes: raw.boxes,
    lines: raw.lines,
    currentLine: Math.max(0, Math.trunc(raw.currentLine)),
    pageLabel: raw.pageLabel.slice(0, 120),
    rightsConfirmed: raw.rightsConfirmed,
  };
}

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new DraftStoreError(
        "This browser cannot keep a local draft. Your work stays on screen until you leave.",
      ),
    );
  }

  if (databasePromise) return databasePromise;

  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;

    try {
      request = indexedDB.open(OCR_DRAFT_DB, DB_VERSION);
    } catch {
      reject(
        new DraftStoreError(
          "This browser is blocking local storage for this site. Allow site data, or keep this tab open until you finish.",
        ),
      );
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OCR_DRAFT_STORE)) {
        database.createObjectStore(OCR_DRAFT_STORE);
      }
    };

    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new DraftStoreError(
          "The local draft database is locked by another tab. Close other tabs and try again.",
        ),
      );
    };

    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        request.error ??
          new DraftStoreError(
            "The local draft database could not be opened. Your work stays on screen.",
          ),
      );
    };

    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      settled = true;
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });

  return databasePromise;
}

export async function readOcrDraft(userId: string): Promise<OcrDraft | null> {
  const database = await openDatabase();
  const key = ocrDraftKey(userId);

  const raw = await new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction(OCR_DRAFT_STORE, "readonly");
    const request = transaction.objectStore(OCR_DRAFT_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ??
          new DraftStoreError("The saved draft could not be read."),
      );
  });

  return parseDraft(raw);
}

export async function writeOcrDraft(
  userId: string,
  input: OcrDraftInput,
): Promise<OcrDraft> {
  const database = await openDatabase();
  const key = ocrDraftKey(userId);
  const draft: OcrDraft = {
    ...input,
    schemaVersion: OCR_DRAFT_SCHEMA_VERSION,
    updatedAt: Date.now(),
  };

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(OCR_DRAFT_STORE, "readwrite");
    transaction.objectStore(OCR_DRAFT_STORE).put(draft, key);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new DraftStoreError(
            "The draft could not be written to this browser.",
          ),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new DraftStoreError(
            "The draft could not be written to this browser.",
          ),
      );
  });

  return draft;
}

export async function deleteOcrDraft(userId: string): Promise<void> {
  const database = await openDatabase();
  const key = ocrDraftKey(userId);

  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(OCR_DRAFT_STORE, "readwrite");
    transaction.objectStore(OCR_DRAFT_STORE).delete(key);

    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ??
          new DraftStoreError("The saved draft could not be deleted."),
      );
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new DraftStoreError("The saved draft could not be deleted."),
      );
  });
}

/** Plain-language copy for storage failures, including a full browser. */
export function draftStoreMessage(error: unknown): string {
  const name = isRecord(error) ? String(error.name ?? "") : "";
  const code = isRecord(error) && isFiniteNumber(error.code) ? error.code : 0;

  if (name === "QuotaExceededError" || code === 22) {
    return "This browser is out of space for the saved page. Delete the draft or free some space, then try again.";
  }

  if (name === "SecurityError" || name === "NotAllowedError") {
    return "This browser is blocking local storage for this site. Allow site data, or keep this tab open until you finish.";
  }

  if (error instanceof DraftStoreError) return error.message;

  return "The local draft could not be accessed. Your work is still on screen. Try again, or keep this tab open until you finish.";
}
