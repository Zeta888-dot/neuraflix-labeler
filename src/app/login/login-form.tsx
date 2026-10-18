"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { emailSchema } from "@/lib/validation";

const BLOCKED_LINK_MESSAGE =
  "That sign-in link could not be verified. Request a new one and try again.";

/* The auth callback sends failures back here with ?error=auth. The URL cannot
   change while the form is mounted, so there is nothing to subscribe to and no
   effect is needed to read it. */
function subscribeToUrl(): () => void {
  return () => {};
}

function readUrlError(): string | null {
  return new URLSearchParams(window.location.search).has("error")
    ? BLOCKED_LINK_MESSAGE
    : null;
}

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const urlError = useSyncExternalStore(
    subscribeToUrl,
    readUrlError,
    () => null,
  );
  const message = error ?? urlError;

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a valid email address");
      return;
    }

    setPending(true);
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: parsed.data,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    setPending(false);
    if (signInError) {
      setError("The sign-in email could not be sent. Try again in a moment.");
      return;
    }
    setSentTo(parsed.data);
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-body-md font-medium text-ink">
            Check your email
          </p>
          <p className="mt-1 text-body-sm text-body">
            A sign-in link is on its way to {sentTo}. Open it in this browser to
            finish signing in.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => {
            setSentTo(null);
            setEmail("");
          }}
        >
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="email" className="text-body-sm font-medium text-ink">
          Email address
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? "email-error" : undefined}
          placeholder="you@example.com"
        />
        {message ? (
          <p id="email-error" role="alert" className="text-body-sm text-error">
            {message}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Sending" : "Send sign-in link"}
      </Button>
    </form>
  );
}
