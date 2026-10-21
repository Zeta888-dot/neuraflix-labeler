import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/session";

/**
 * Optimistic route protection. Everything except /login, /auth/callback and
 * the /api/health keep-alive probe requires a session; the authoritative check
 * happens again in the server layouts (src/lib/auth.ts).
 */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;

  return updateSession(request).then(({ response, userId }) => {
    const isPublic =
      path === "/login" ||
      path.startsWith("/auth/") ||
      path === "/api/health";

    if (!userId && !isPublic) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "";
      return NextResponse.redirect(url, { headers: response.headers });
    }

    if (userId && path === "/login") {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return NextResponse.redirect(url, { headers: response.headers });
    }

    return response;
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};
