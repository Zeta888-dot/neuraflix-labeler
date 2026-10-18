import { DEFAULT_PARAMS, LineBox, SegParams, segmentPage } from "./segment";
import { BUCKET, supabaseAdmin } from "./supabase";

export type Meta = {
  params: SegParams;
  angle: number;
  boxes: Record<string, LineBox>;
};
export type PageSummary = { id: string; lines: number; labeled: number };
export type LineInfo = { i: number; label: string };
export type PageDetail = {
  id: string;
  params: SegParams;
  angle: number;
  lines: LineInfo[];
};

type Seg = Awaited<ReturnType<typeof segmentPage>>;

const pad2 = (i: number) => String(i).padStart(2, "0");
export const imageFile = (i: number) => `image_${pad2(i)}.jpg`;
export const labelFile = (i: number) => `label_${pad2(i)}.txt`;

export function sanitizeLabel(t: string) {
  return t.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function validId(id: string) {
  return /^[\w-]+$/.test(id);
}

function assertId(id: string) {
  if (!validId(id)) throw new Error("bad page id");
}

const db = () => supabaseAdmin();
const filePath = (id: string, file: string) => `${id}/${file}`;

// throws if a Supabase call returned an error, otherwise returns its data
function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

async function upload(
  id: string,
  file: string,
  body: Buffer,
  contentType = "image/jpeg"
) {
  check(
    await db().storage.from(BUCKET).upload(filePath(id, file), body, {
      contentType,
      upsert: true,
    })
  );
}

// removes files inside a page folder (all of them, or only names matching `only`)
async function removeFiles(id: string, only?: RegExp) {
  const sb = db();
  const list = check(await sb.storage.from(BUCKET).list(id, { limit: 1000 }));
  const paths = (list ?? [])
    .map((f) => f.name)
    .filter((n) => !only || only.test(n))
    .map((n) => filePath(id, n));
  if (paths.length) check(await sb.storage.from(BUCKET).remove(paths));
}

async function uniqueId(name: string) {
  const stem = name.replace(/\.[^.]+$/, "");
  const base = stem.replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "") || "page";
  const rows = check(await db().from("pages").select("id").like("id", `${base}%`)) as {
    id: string;
  }[];
  const taken = new Set(rows.map((r) => r.id));
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

async function pageLines(id: string): Promise<LineInfo[]> {
  const rows = check(
    await db()
      .from("lines")
      .select("line_index,label")
      .eq("page_id", id)
      .order("line_index")
  ) as { line_index: number; label: string }[];
  return rows.map((r) => ({ i: r.line_index, label: r.label ?? "" }));
}

// writes page row + line images + overlay + line rows (page row first: FK)
async function writeSegmentation(id: string, params: SegParams, seg: Seg) {
  const sb = db();
  const boxes: Record<string, LineBox> = {};
  seg.lines.forEach((_, k) => {
    boxes[String(k + 1)] = seg.boxes[k];
  });

  check(
    await sb
      .from("pages")
      .upsert({ id, params, angle: seg.angle, boxes }, { onConflict: "id" })
  );

  await Promise.all([
    ...seg.lines.map((buf, k) => upload(id, imageFile(k + 1), buf)),
    upload(id, "overlay.jpg", seg.overlay),
  ]);

  if (seg.lines.length) {
    check(
      await sb.from("lines").insert(
        seg.lines.map((_, k) => ({ page_id: id, line_index: k + 1, label: "" }))
      )
    );
  }
}

// ------------------------------------------------------------------ public API

export async function listPages(): Promise<PageSummary[]> {
  const sb = db();
  const pages = check(await sb.from("pages").select("id").order("id")) as {
    id: string;
  }[];

  // Supabase returns max 1000 rows per request, so page through the lines table
  const counts = new Map<string, { lines: number; labeled: number }>();
  for (let from = 0; ; from += 1000) {
    const rows = check(
      await sb
        .from("lines")
        .select("page_id,label")
        .order("page_id")
        .order("line_index")
        .range(from, from + 999)
    ) as { page_id: string; label: string }[];
    for (const r of rows) {
      const c = counts.get(r.page_id) ?? { lines: 0, labeled: 0 };
      c.lines++;
      if ((r.label ?? "").trim()) c.labeled++;
      counts.set(r.page_id, c);
    }
    if (rows.length < 1000) break;
  }

  return pages.map((p) => ({
    id: p.id,
    lines: counts.get(p.id)?.lines ?? 0,
    labeled: counts.get(p.id)?.labeled ?? 0,
  }));
}

export async function createPage(
  name: string,
  buffer: Buffer,
  params: SegParams = DEFAULT_PARAMS
): Promise<string> {
  const seg = await segmentPage(buffer, params); // fails early, nothing stored yet
  const id = await uniqueId(name);
  try {
    await upload(id, "original.img", buffer, "application/octet-stream");
    await writeSegmentation(id, params, seg);
  } catch (err) {
    await removeFiles(id).catch(() => {});
    await db().from("pages").delete().eq("id", id);
    throw err;
  }
  return id;
}

export async function getPage(id: string): Promise<PageDetail | null> {
  assertId(id);
  const { data, error } = await db()
    .from("pages")
    .select("id,params,angle")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id,
    params: data.params as SegParams,
    angle: data.angle as number,
    lines: await pageLines(id),
  };
}

export async function saveLabel(id: string, i: number, text: string): Promise<string> {
  assertId(id);
  const clean = sanitizeLabel(text);
  check(
    await db()
      .from("lines")
      .update({ label: clean })
      .eq("page_id", id)
      .eq("line_index", i)
  );
  return clean;
}

export async function deleteLine(id: string, i: number) {
  assertId(id);
  check(await db().from("lines").delete().eq("page_id", id).eq("line_index", i));
  check(await db().storage.from(BUCKET).remove([filePath(id, imageFile(i))]));
}

export async function deletePage(id: string) {
  assertId(id);
  await removeFiles(id);
  check(await db().from("pages").delete().eq("id", id)); // lines rows cascade
}

export async function resegment(id: string, params: SegParams, force = false) {
  assertId(id);
  const sb = db();

  if (!force) {
    const { count, error } = await sb
      .from("lines")
      .select("*", { count: "exact", head: true })
      .eq("page_id", id)
      .neq("label", "");
    if (error) throw new Error(error.message);
    if ((count ?? 0) > 0) throw new Error("labels_exist");
  }

  const dl = await sb.storage.from(BUCKET).download(filePath(id, "original.img"));
  if (dl.error || !dl.data) throw new Error(dl.error?.message ?? "original not found");
  const original = Buffer.from(await dl.data.arrayBuffer());

  const seg = await segmentPage(original, params); // compute first, replace after

  check(await sb.from("lines").delete().eq("page_id", id));
  await removeFiles(id, /^image_\d+\.jpg$/);
  await writeSegmentation(id, params, seg);
}