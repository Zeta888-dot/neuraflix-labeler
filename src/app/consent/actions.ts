"use server";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { consentSchema } from "@/lib/validation";

export type ConsentState = { error: string | null };

/**
 * Records consent with the version string "v1". Both confirmations must be
 * checked; the server never trusts the client for this.
 */
export async function saveConsent(
  _previous: ConsentState,
  formData: FormData,
): Promise<ConsentState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const parsed = consentSchema.safeParse({
    open_datasets: formData.get("open_datasets"),
    rights: formData.get("rights"),
  });

  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ??
        "Both confirmations are required to continue",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      consent_version: "v1",
      consent_at: new Date().toISOString(),
    })
    .eq("id", user.id);

  if (error) {
    return { error: "Consent could not be saved. Please try again." };
  }

  redirect("/dashboard");
}
