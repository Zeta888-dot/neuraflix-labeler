export type Role = "contributor" | "reviewer" | "admin";

export type Profile = {
  id: string;
  display_name: string | null;
  role: Role;
  consent_version: string | null;
  consent_at: string | null;
  created_at: string;
};

export type SessionUser = {
  id: string;
  email: string | null;
};
