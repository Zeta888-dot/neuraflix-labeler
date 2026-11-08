import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import {
  getImportSources,
  getUploadStatus,
} from "@/lib/admin/upload/upload-server";
import { getProfile, getSessionUser } from "@/lib/auth";
import { UploadWorkspace } from "./upload-client";

export const metadata: Metadata = {
  title: "Upload data",
};

/* The header is static. The role check, the status and the recent sources
   happen behind the boundary. A non-admin gets a 404. */
export default function AdminUploadPage() {
  return (
    <>
      <PageHeader
        title="Upload data"
        description="Admin only. Load instruction and response data in chunks, resume by selecting the same file, and review row errors."
      />
      <Suspense fallback={<UploadSkeleton />}>
        <UploadLoader />
      </Suspense>
    </>
  );
}

async function UploadLoader() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getProfile(user.id);
  if (!profile || profile.role !== "admin") notFound();

  const [status, sources] = await Promise.all([
    getUploadStatus(),
    getImportSources(20),
  ]);

  return (
    <div className="mt-6">
      <UploadWorkspace
        initialStatus={status}
        initialSources={sources ?? []}
      />
    </div>
  );
}

function UploadSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card>
        <p className="text-body-sm text-mute">Loading the upload status...</p>
      </Card>
    </div>
  );
}
