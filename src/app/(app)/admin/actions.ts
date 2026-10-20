"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  adminRoleLabels,
  adminRoleSchema,
  type AdminUser,
} from "@/lib/admin";
import { getAdminUsers } from "@/lib/admin-server";
import { getProfile, getSessionUser } from "@/lib/auth";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server actions for the admin user list. Both checks run again here: the
 * session must belong to an admin, and the database function checks the role
 * once more before it writes.
 */

const FORBIDDEN_MESSAGE = "Your account cannot change roles right now.";
const AUTH_MESSAGE = "Your session expired. Sign in again, then retry.";

async function requireAdmin(): Promise<string | null> {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getProfile(user.id);
  if (!profile || profile.role !== "admin") return null;
  return user.id;
}

const changeRoleSchema = z.object({
  userId: z.uuid(),
  role: adminRoleSchema,
});

export type ChangeRoleResult =
  | { status: "changed"; message: string; users: AdminUser[] | null }
  | { status: "error"; message: string };

export async function changeUserRole(
  input: unknown,
): Promise<ChangeRoleResult> {
  const adminId = await requireAdmin();
  if (!adminId) return { status: "error", message: FORBIDDEN_MESSAGE };

  const parsed = changeRoleSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "error", message: "That role change could not be read." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_role", {
    p_user_id: parsed.data.userId,
    p_role: parsed.data.role,
  });

  if (error) {
    logRpcError("[admin_set_role]", error);
    return { status: "error", message: roleErrorMessage(error.message ?? "") };
  }

  revalidatePath("/admin");

  return {
    status: "changed",
    message: `Role changed to ${adminRoleLabels[parsed.data.role]}.`,
    users: await getAdminUsers(),
  };
}

function roleErrorMessage(raw: string): string {
  const message = raw ?? "";

  if (message.includes("SELF_ROLE")) {
    return "You cannot change your own role.";
  }
  if (message.includes("LAST_ADMIN")) {
    return "There must be at least one admin. Give another account the admin role first.";
  }
  if (message.includes("ADMIN_USER_NOT_FOUND")) {
    return "That account could not be found. Reload the page.";
  }
  if (message.includes("ADMIN_INVALID_ROLE")) {
    return "Choose Contributor, Reviewer or Admin.";
  }
  if (message.includes("ADMIN_FORBIDDEN")) {
    return FORBIDDEN_MESSAGE;
  }
  if (message.includes("ADMIN_AUTH_REQUIRED")) {
    return AUTH_MESSAGE;
  }

  return "The role could not be changed. Try again in a moment.";
}
