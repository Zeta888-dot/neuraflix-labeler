import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Reads the access token expiry straight from the auth cookie, without a
 * Supabase call. This is optimistic only: the signature is not checked here.
 * The server layouts still call `getClaims()`, which verifies it.
 */
function readLocalSession(
  request: NextRequest,
): { userId: string; expiresAt: number } | null {
  const projectRef = new URL(supabaseUrl()).hostname.split(".")[0];
  const key = `sb-${projectRef}-auth-token`;
  const all = request.cookies.getAll();

  let raw = all.find((cookie) => cookie.name === key)?.value;
  if (!raw) {
    const chunks = all
      .filter((cookie) => cookie.name.startsWith(`${key}.`))
      .map((cookie) => ({
        index: Number(cookie.name.slice(key.length + 1)),
        value: cookie.value,
      }))
      .filter((chunk) => Number.isInteger(chunk.index))
      .sort((a, b) => a.index - b.index);
    if (chunks.length === 0) return null;
    raw = chunks.map((chunk) => chunk.value).join("");
  }

  if (!raw.startsWith("base64-")) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8"),
    ) as { expires_at?: unknown; user?: { id?: unknown } };
    const userId = typeof parsed.user?.id === "string" ? parsed.user.id : null;
    const expiresAt =
      typeof parsed.expires_at === "number" ? parsed.expires_at : null;
    if (!userId || !expiresAt) return null;
    return { userId, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Refreshes the Supabase session for a request and reports who is signed in.
 *
 * The common case is a valid cookie, so it is read locally and no network call
 * is made. A missing, unreadable or about-to-expire token falls back to
 * `getClaims()`, which refreshes through the SDK and can write new cookies.
 */
export async function updateSession(
  request: NextRequest,
): Promise<{ response: NextResponse; userId: string | null }> {
  const local = readLocalSession(request);
  if (
    local &&
    local.expiresAt - Math.floor(Date.now() / 1000) > 60
  ) {
    return { response: NextResponse.next({ request }), userId: local.userId };
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === "string" ? data.claims.sub : null;

  return { response, userId };
}
