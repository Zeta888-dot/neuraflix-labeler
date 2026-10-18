import { NextResponse } from "next/server";
import { exportTraining } from "@/lib/export";

export async function POST() {
  try {
    const r = await exportTraining();
    return NextResponse.json({
      ok: true,
      count: r.total, // kept for the existing UI
      path: r.dir,
      ...r,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg === "no labeled lines to export" ? 400 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}