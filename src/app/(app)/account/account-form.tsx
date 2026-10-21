"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { updateDisplayName, type AccountState } from "./actions";

const initialState: AccountState = { status: "idle", message: null };

export function AccountForm({
  initialDisplayName,
}: {
  initialDisplayName: string;
}) {
  const [state, formAction, pending] = useActionState(
    updateDisplayName,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label
          htmlFor="display_name"
          className="text-body-sm font-medium text-ink"
        >
          Display name
        </label>
        <Input
          id="display_name"
          name="display_name"
          type="text"
          autoComplete="nickname"
          defaultValue={initialDisplayName}
          placeholder="How your name appears in the sidebar"
          aria-describedby={
            state.message
              ? "display_name_hint display_name_status"
              : "display_name_hint"
          }
        />
        <p id="display_name_hint" className="text-caption text-mute">
          Optional. It is shown in the sidebar and in your account menu, and it
          is the only personal detail stored besides your email address.
        </p>
      </div>

      {state.message ? (
        <p
          id="display_name_status"
          role={state.status === "error" ? "alert" : "status"}
          className={
            state.status === "error"
              ? "text-body-sm text-error"
              : "text-body-sm text-body"
          }
        >
          {state.message}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving" : "Save display name"}
      </Button>
    </form>
  );
}
