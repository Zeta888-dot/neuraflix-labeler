import type { Role } from "../../types";

/**
 * The browser import is admin only. The server action calls this after reading
 * the profile, and the database checks is_admin() again inside every RPC.
 */
export function canImport(role: Role | null | undefined): boolean {
  return role === "admin";
}
