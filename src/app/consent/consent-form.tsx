"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { saveConsent, type ConsentState } from "./actions";

const initialState: ConsentState = { error: null };

export function ConsentForm() {
  const [state, formAction, pending] = useActionState(
    saveConsent,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-4">
        <legend className="sr-only">Consent confirmation</legend>
        <Checkbox
          name="open_datasets"
          required
          label="I understand my contributions will be used to build and release open Khowar datasets and models."
        />
        <Checkbox
          name="rights"
          required
          label="I will only submit text and images I wrote or have the right to share."
        />
      </fieldset>

      {state.error ? (
        <p role="alert" className="text-body-sm text-error">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving" : "Continue"}
      </Button>
    </form>
  );
}
