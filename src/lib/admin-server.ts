import {
  parseAdminOverview,
  parseAdminSettings,
  parseAdminUser,
  type AdminOverview,
  type AdminSettings,
  type AdminUser,
} from "@/lib/admin";
import { logRpcError } from "@/lib/rpc-log";
import { createClient } from "@/lib/supabase/server";

/**
 * Server only reads for the admin overview and the user role list. Both RPCs
 * check that the caller is an admin inside the database. The page checks the
 * role before it calls them.
 */

export async function getAdminOverview(): Promise<AdminOverview | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_overview");

  if (error) {
    logRpcError("[admin_overview]", error);
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const overview = parseAdminOverview(rows[0]);

  if (!overview) {
    logRpcError("[admin_overview]", {
      message: "Unexpected admin_overview payload",
      code: "ADMIN_PARSE",
    });
    return null;
  }

  return overview;
}

export async function getAdminUsers(): Promise<AdminUser[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_users");

  if (error) {
    logRpcError("[admin_users]", error);
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const users = rows
    .map(parseAdminUser)
    .filter((user): user is AdminUser => user !== null);

  if (users.length !== rows.length) {
    logRpcError("[admin_users]", {
      message: "Unexpected admin_list_users payload",
      code: "ADMIN_PARSE",
    });
    return null;
  }

  return users;
}

/** Read-only settings. The RPC checks the admin role again in the database. */
export async function getAdminSettings(): Promise<AdminSettings | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_settings_status");

  if (error) {
    logRpcError("[admin_settings]", error);
    return null;
  }

  const rows = Array.isArray(data) ? data : [];
  const settings = parseAdminSettings(rows[0]);

  if (!settings) {
    logRpcError("[admin_settings]", {
      message: "Unexpected admin_settings_status payload",
      code: "ADMIN_PARSE",
    });
    return null;
  }

  return settings;
}

/** Both admin reads at once, so the page makes one pass. */
export async function getAdminData(): Promise<{
  overview: AdminOverview | null;
  users: AdminUser[] | null;
}> {
  const [overview, users] = await Promise.all([
    getAdminOverview(),
    getAdminUsers(),
  ]);

  return { overview, users };
}
