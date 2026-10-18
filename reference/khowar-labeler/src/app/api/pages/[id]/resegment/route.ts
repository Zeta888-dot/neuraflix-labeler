import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_PARAMS, SegParams } from "@/lib/segment";
import { getPage, resegment, validId } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

function clamp(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseParams(raw: unknown): SegParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    deskew: typeof r.deskew === "boolean" ? r.deskew : DEFAULT_PARAMS.deskew,
    sensitivity: clamp(r.sensitivity, 0.001, 0.3, DEFAULT_PARAMS.sensitivity),
    minHeight: Math.round(clamp(r.minHeight, 1, 200, DEFAULT_PARAMS.minHeight)),
    mergeGap: Math.round(clamp(r.mergeGap, 0, 100, DEFAULT_PARAMS.mergeGap)),
    pad: Math.round(clamp(r.pad, 0, 60, DEFAULT_PARAMS.pad)),
  };
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!validId(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (!(await getPage(id))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    params?: unknown;
    force?: unknown;
  };

  try {
    await resegment(id, parseParams(body.params), body.force === true);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "labels_exist") {
      return NextResponse.json({ error: "labels_exist" }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}