import { redirect } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import type { Profile, SessionUser } from "@/lib/types";

/**
 * The signed-in user, verified through the access token claims, or null.
 *
 * Reading the session compares the access token's expiry with the clock inside
 * the auth client, so it can only run at request time. `connection()` stops
 * prerendering before that check instead of letting it fail the route, which
 * is why every caller can stay a blocking server component.
 *
 * `cache` dedupes the call across the layout, the page and any nested loaders
 * in the same request, so the JWT is checked once per request, not once per
 * component.
 */
export const getSessionUser = cache(async function getSessionUser(): Promise<SessionUser | null> {
  await connection();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error) return null;
  const claims = data?.claims;
  const id = typeof claims?.sub === "string" ? claims.sub : null;
  if (!id) return null;
  return { id, email: typeof claims?.email === "string" ? claims.email : null };
});

/** The profile row created by the on-signup database trigger, or null. */
export const getProfile = cache(async function getProfile(
  userId: string,
): Promise<Profile | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, display_name, role, consent_version, consent_at, created_at")
    .eq("id", userId)
    .maybeSingle();

  return (data as Profile | null) ?? null;
});

/** Requires a session. Redirects to /login when there is none. */
export const requireSessionUser = cache(async function requireSessionUser(): Promise<{
  user: SessionUser;
  profile: Profile | null;
}> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return { user, profile: await getProfile(user.id) };
});

/**
 * Requires a session and recorded consent. Redirects to /login or /consent so
 * no protected page renders before both are true.
 */
export const requireAppUser = cache(async function requireAppUser(): Promise<{
  user: SessionUser;
  profile: Profile;
}> {
  const { user, profile } = await requireSessionUser();
  if (!profile?.consent_at) redirect("/consent");
  return { user, profile };
});
