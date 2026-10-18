import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LabelerWordmark } from "@/components/brand/Wordmark";
import { Card } from "@/components/ui/card";
import { requireSessionUser } from "@/lib/auth";
import { ConsentForm } from "./consent-form";

export const metadata: Metadata = {
  title: "Consent",
};

/* Consent state is per session and lives in the database. */
export const instant = false;

export default async function ConsentPage() {
  const { profile } = await requireSessionUser();

  if (profile?.consent_at) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl">
        <LabelerWordmark size={20} />
        <h1 className="mt-6 text-display-md font-semibold tracking-[-0.04em]">
          Before you start
        </h1>
        <p className="mt-2 max-w-[65ch] text-body-sm text-body">
          Two confirmations are required before contributing. They are recorded
          once and can be reviewed on your account page.
        </p>
        <Card className="mt-8">
          {profile ? (
            <ConsentForm />
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-body-md font-medium text-ink">
                Your profile was not found
              </p>
              <p className="max-w-[65ch] text-body-sm text-body">
                Profiles are created by a database trigger on first sign-in. If
                the migration in supabase/migrations/0001_init.sql has not been
                run yet, paste it into the Supabase SQL editor, then sign out
                and sign in again.
              </p>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
