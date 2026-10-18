import type { Metadata } from "next";
import { LabelerWordmark } from "@/components/brand/Wordmark";
import { Card } from "@/components/ui/card";
import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="flex flex-col gap-3">
          <LabelerWordmark size={22} />
          <h1 className="text-display-md font-semibold tracking-[-0.04em]">
            Sign in
          </h1>
          <p className="max-w-[65ch] text-body-sm text-body">
            Enter your email address and we will send you a sign-in link. No
            password needed.
          </p>
        </div>
        <Card className="mt-8">
          <LoginForm />
        </Card>
        <p className="mt-6 text-caption text-mute">
          A quick note on privacy: only your email address is stored, plus an
          optional display name you can edit later.
        </p>
      </div>
    </main>
  );
}
