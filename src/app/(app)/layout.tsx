import { AppShell } from "@/components/app-shell/app-shell";
import { requireAppUser } from "@/lib/auth";

/* Session and profile reads are request-time work. This layout is allowed to
   block on the server instead of prerendering a shell it cannot fill. */
export const instant = false;

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, profile } = await requireAppUser();
  const displayName = profile.display_name?.trim() || user.email || "Account";

  return (
    <AppShell
      user={{ displayName, email: user.email, role: profile.role }}
    >
      {children}
    </AppShell>
  );
}
