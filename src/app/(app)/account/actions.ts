"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { displayNameSchema } from "@/lib/validation";

export type AccountState = {
  status: "idle" | "saved" | "error";
  message: string | null;
};

/** Saves the optional display name. Nothing else on the profile is writable. */
export async function updateDisplayName(
  _previous: AccountState,
  formData: FormData,
): Promise<AccountState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const parsed = displayNameSchema.safeParse(
    formData.get("display_name") ?? "",
  );
  if (!parsed.success) {
    return {
      status: "error",
      message:
        parsed.error.issues[0]?.message ?? "That display name is not valid",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data })
    .eq("id", user.id);

  if (error) {
    return {
      status: "error",
      message: "The display name could not be saved. Please try again.",
    };
  }

  revalidatePath("/account");
  return { status: "saved", message: "Display name saved." };
}
