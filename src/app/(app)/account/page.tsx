import type { Metadata } from "next";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { requireAppUser } from "@/lib/auth";
import { AccountForm } from "./account-form";

export const metadata: Metadata = {
  title: "Account",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
    new Date(value),
  );
}

export default async function AccountPage() {
  const { user, profile } = await requireAppUser();

  return (
    <>
      <PageHeader
        title="Account"
        description="Your display name and the details stored for this account."
      />
      <Card className="mt-6 max-w-xl">
        <AccountForm initialDisplayName={profile.display_name ?? ""} />

        <dl className="mt-8 flex flex-col gap-4 border-t border-hairline pt-6">
          <div>
            <dt className="text-caption text-mute">Email address</dt>
            <dd className="text-body-sm text-ink">
              {user.email ?? "Not available"}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-mute">Role</dt>
            <dd className="text-body-sm text-ink capitalize">
              {profile.role}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-mute">Consent</dt>
            <dd className="text-body-sm text-ink">
              {profile.consent_at
                ? `Version ${profile.consent_version ?? "v1"}, recorded ${formatDate(profile.consent_at)}`
                : "Not recorded"}
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
