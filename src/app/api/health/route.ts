import { createClient } from "@supabase/supabase-js";
import { connection, NextResponse } from "next/server";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Keep-alive probe for the free Supabase project. It calls health_ping() with
 * the anon key and returns nothing but a boolean state. No table is read and
 * no error detail, URL or key is ever included in the response.
 */
export async function GET() {
  // Keep the probe at request time. The build prerenderer must not call
  // Supabase while generating static pages.
  await connection();
  const headers = { "Cache-Control": "no-store" };

  try {
    const supabase = createClient(supabaseUrl(), supabaseAnonKey(), {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const { data, error } = await supabase.rpc("health_ping");

    if (error || data !== true) {
      console.error("[health]", {
        message: error?.message ?? "Unexpected health_ping result",
        code: error?.code ?? null,
      });
      return NextResponse.json({ ok: false }, { status: 503, headers });
    }

    return NextResponse.json({ ok: true }, { headers });
  } catch {
    console.error("[health]", {
      message: "Health check failed",
      code: null,
    });
    return NextResponse.json({ ok: false }, { status: 503, headers });
  }
}
