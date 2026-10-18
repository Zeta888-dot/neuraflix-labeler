import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Server client for Server Components and Server Actions. One client per
 * request, never shared. `cookies()` is read first, so prerendering bails out
 * to request-time rendering before any env value is needed.
 *
 * Server Components cannot write cookies; the session refresh in
 * src/proxy.ts is what keeps the session alive.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: ignore. The proxy refreshes the
          // session before the request reaches rendering.
        }
      },
    },
  });
}
