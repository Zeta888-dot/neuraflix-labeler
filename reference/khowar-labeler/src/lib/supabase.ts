// Server-only helper. Never import this from a "use client" file
// (it uses the service role key).
import { createClient } from "@supabase/supabase-js";

export const BUCKET = "lines";

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing");
  return createClient(url, key, { auth: { persistSession: false } });
}