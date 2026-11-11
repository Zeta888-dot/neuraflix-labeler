import type { Metadata } from "next";
import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
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

export default function AccountPage() {
  return (
    <>
      <PageHeader
        title="Account"
        description="Your display name and the details stored for this account."
      />
      <Suspense fallback={<AccountBodySkeleton />}>
        <AccountBody />
      </Suspense>
    </>
  );
}

async function AccountBody() {
  const { user, profile } = await requireAppUser();

  return (
    <Card className="mt-6">
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
  );
}

function AccountBodySkeleton() {
  return (
    <div
      className="mt-6 rounded-lg bg-surface p-6 shadow-elev-2"
      aria-hidden="true"
    >
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="mt-4 h-10 w-36 rounded-md" />
      <div className="mt-8 flex flex-col gap-4 border-t border-hairline pt-6">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-56" />
          </div>
        ))}
      </div>
    </div>
  );
}
