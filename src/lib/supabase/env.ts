/**
 * Public Supabase settings. The literal `process.env.NEXT_PUBLIC_*` reads are
 * what Next.js inlines into the browser bundle, so they must stay spelled out
 * here (no dynamic lookups).
 */
export function supabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!value) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set");
  }
  return value;
}

export function supabaseAnonKey(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!value) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  }
  return value;
}
