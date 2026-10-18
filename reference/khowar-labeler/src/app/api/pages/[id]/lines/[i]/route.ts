import { NextRequest, NextResponse } from "next/server";
import { deleteLine, saveLabel, validId } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string; i: string }> };

async function parse(ctx: Ctx) {
  const { id, i } = await ctx.params;
  const n = Number(i);
  if (!validId(id) || !Number.isInteger(n) || n < 1) return null;
  return { id, i: n };
}

// Save (or clear, if empty) the typed label for one line
export async function PUT(req: NextRequest, ctx: Ctx) {
  const p = await parse(ctx);
  if (!p) return NextResponse.json({ error: "bad request" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  if (!body || typeof body.text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  const label = await saveLabel(p.id, p.i, body.text);
  return NextResponse.json({ ok: true, label });
}

// Remove a bad line (image + label)
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const p = await parse(ctx);
  if (!p) return NextResponse.json({ error: "bad request" }, { status: 400 });

  await deleteLine(p.id, p.i);
  return NextResponse.json({ ok: true });
}