import { NextRequest, NextResponse } from "next/server";
import { validId } from "@/lib/storage";
import { BUCKET, supabaseAdmin } from "@/lib/supabase";

type Ctx = { params: Promise<{ id: string; file: string }> };

const ALLOWED = /^(image_\d+\.jpg|overlay\.jpg)$/;

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id, file } = await params;
  if (!validId(id) || !ALLOWED.test(file)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .storage.from(BUCKET)
    .download(`${id}/${file}`);

  if (error || !data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return new Response(new Uint8Array(await data.arrayBuffer()), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "no-store",
    },
  });
}