import crypto from "crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { imageFile } from "./storage";
import { BUCKET, supabaseAdmin } from "./supabase";

export const EXPORT_BUCKET = "exports";
export const EXPORT_FILE = "latest.zip";

export type ExportOptions = {
  /** fraction held out for validation (0 = no val split) */
  valRatio: number;
  /** user prompt used in the DeepSeek-OCR conversation format */
  prompt: string;
};

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  valRatio: 0.1,
  prompt: "<image>\nFree OCR. ",
};

export type ExportSummary = {
  name: string;
  /** label shown in the UI (the zip file name) */
  dir: string;
  /** signed download link for the zip (valid ~1 hour) */
  url: string;
  total: number;
  train: number;
  val: number;
  pages: number;
  warnings: string[];
};

type RawRow = { id: string; page: string; line: number; text: string };
type Row = RawRow & { split: "train" | "val" };

// Invisible direction/format marks that sneak in from keyboards.
// ZWNJ (U+200C) and ZWJ (U+200D) are intentionally KEPT: they are meaningful in Arabic-script text.
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function normalizeLabel(t: string): string {
  return t.normalize("NFC").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
}

// Deterministic 0..1 value from a string (stable across exports)
function bucket(key: string): number {
  const d = crypto.createHash("sha1").update(key).digest();
  return d.readUInt32BE(0) / 0x100000000;
}

// Arabic-keyboard characters that usually mean the wrong keyboard layout was used
const CONFUSABLE: Record<string, string> = {
  "\u064A": "Arabic Yeh (ي); Urdu/Khowar keyboard mein ی (U+06CC) hota hai",
  "\u0649": "Alef Maksura (ى); shayad ی (U+06CC) chahiye tha",
  "\u0643": "Arabic Kaf (ك); Urdu keyboard mein ک (U+06A9) hota hai",
  "\u0647": "Arabic Heh (ه); Urdu keyboard mein ہ (U+06C1) ya ھ (U+06BE) hota hai",
};

// all labeled lines, ordered by page then line (a deleted line has no row at all)
async function collect(): Promise<RawRow[]> {
  const sb = supabaseAdmin();
  const rows: RawRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("lines")
      .select("page_id,line_index,label")
      .neq("label", "")
      .order("page_id")
      .order("line_index")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const text = normalizeLabel(r.label ?? "");
      if (!text) continue;
      const num = String(r.line_index).padStart(2, "0");
      rows.push({
        id: `${r.page_id}_${num}`,
        page: r.page_id,
        line: r.line_index,
        text,
      });
    }
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// downloads every line image from Storage (12 at a time)
async function fetchImages(rows: Row[]): Promise<Map<string, Uint8Array>> {
  const sb = supabaseAdmin();
  const out = new Map<string, Uint8Array>();
  let next = 0;
  async function worker() {
    while (next < rows.length) {
      const r = rows[next++];
      const p = `${r.page}/${imageFile(r.line)}`;
      const { data, error } = await sb.storage.from(BUCKET).download(p);
      if (error || !data) throw new Error(`image missing in storage: ${p}`);
      out.set(r.id, new Uint8Array(await data.arrayBuffer()));
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}

export async function exportTraining(
  opts: ExportOptions = DEFAULT_EXPORT_OPTIONS
): Promise<ExportSummary> {
  const raw = await collect();
  if (!raw.length) throw new Error("no labeled lines to export");

  // --- train / val split: page-level first (no leakage between train and val)
  let rows: Row[] = raw.map((r) => ({
    ...r,
    split: opts.valRatio > 0 && bucket(r.page) < opts.valRatio ? "val" : "train",
  }));
  const needFallback =
    opts.valRatio > 0 &&
    (!rows.some((r) => r.split === "val") || !rows.some((r) => r.split === "train"));
  if (needFallback) {
    // too few pages for a page-level split -> deterministic line-level split
    rows = raw.map((r) => ({
      ...r,
      split:
        raw.length >= 20 && bucket(`${r.page}/${r.line}`) < opts.valRatio ? "val" : "train",
    }));
  }
  const train = rows.filter((r) => r.split === "train");
  const val = rows.filter((r) => r.split === "val");

  // --- formats
  const jsonl = (rs: Row[]) =>
    rs
      .map((r) =>
        JSON.stringify({
          messages: [
            { role: "<|User|>", content: opts.prompt, images: [`images/${r.id}.jpg`] },
            { role: "<|Assistant|>", content: r.text },
          ],
        })
      )
      .join("\n") + "\n";
  const paddle = (rs: Row[]) =>
    rs.map((r) => `images/${r.id}.jpg\t${r.text}`).join("\n") + "\n";

  // --- charset report + warnings
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const ch of Array.from(r.text)) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const charset = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([char, count]) => ({
      char,
      code: "U+" + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"),
      count,
    }));

  const warnings: string[] = [];
  for (const c of charset) {
    const hint = CONFUSABLE[c.char];
    if (hint) warnings.push(`${c.code} ${c.char} x${c.count}: ${hint}`);
    else if (/[A-Za-z]/.test(c.char)) {
      warnings.push(`${c.code} "${c.char}" x${c.count}: Latin letter (typo?)`);
    }
  }

  const pageCount = new Set(rows.map((r) => r.page)).size;

  // --- build the zip in memory (jpgs are already compressed -> level 0)
  const images = await fetchImages(rows);
  const files: Zippable = {};
  for (const r of rows) {
    files[`images/${r.id}.jpg`] = [images.get(r.id)!, { level: 0 }];
  }
  files["train.jsonl"] = strToU8(jsonl(train));
  files["train.txt"] = strToU8(paddle(train));
  if (val.length) {
    files["val.jsonl"] = strToU8(jsonl(val));
    files["val.txt"] = strToU8(paddle(val));
  }
  files["charset.json"] = strToU8(JSON.stringify(charset, null, 1));
  files["manifest.json"] = strToU8(
    JSON.stringify(
      {
        created: new Date().toISOString(),
        options: opts,
        counts: {
          total: rows.length,
          train: train.length,
          val: val.length,
          pages: pageCount,
        },
        warnings,
        rows: rows.map(({ id, page, line, split }) => ({ id, page, line, split })),
      },
      null,
      1
    )
  );
  const zip = zipSync(files);

  // --- upload (always overwrites the previous export) + signed link
  const sb = supabaseAdmin();
  const up = await sb.storage.from(EXPORT_BUCKET).upload(EXPORT_FILE, Buffer.from(zip), {
    contentType: "application/zip",
    upsert: true,
  });
  if (up.error) throw new Error(`zip upload failed: ${up.error.message}`);

  const signed = await sb.storage
    .from(EXPORT_BUCKET)
    .createSignedUrl(EXPORT_FILE, 3600, { download: "khowar_dataset.zip" });
  if (signed.error || !signed.data) {
    throw new Error(signed.error?.message ?? "could not create download link");
  }

  return {
    name: "latest",
    dir: EXPORT_FILE,
    url: signed.data.signedUrl,
    total: rows.length,
    train: train.length,
    val: val.length,
    pages: pageCount,
    warnings,
  };
}