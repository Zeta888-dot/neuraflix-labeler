import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_PARAMS } from "@/lib/segment";
import { createPage, listPages } from "@/lib/storage";

export async function GET() {
  return NextResponse.json({ pages: await listPages() });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  if (!files.length) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }

  const created: string[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const f of files) {
    try {
      const buf = Buffer.from(await f.arrayBuffer());
      created.push(await createPage(f.name || "page.png", buf, DEFAULT_PARAMS));
    } catch (e) {
      errors.push({ name: f.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ created, errors });
}