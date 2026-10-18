import { NextRequest, NextResponse } from "next/server";
import { deletePage, getPage, validId } from "@/lib/storage";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!validId(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const page = await getPage(id);
  if (!page) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(page);
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!validId(id)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  await deletePage(id);
  return NextResponse.json({ ok: true });
}