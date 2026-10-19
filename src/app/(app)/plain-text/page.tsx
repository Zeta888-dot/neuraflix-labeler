import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { getSessionUser } from "@/lib/auth";
import { getPlainTextPage } from "@/lib/plain-text-server";
import { PlainTextWorkspace } from "./plain-text-workspace";

export const metadata: Metadata = {
  title: "Plain text",
};

/* The header is static. The form and the submission list need the session, so
   they stream in behind their own boundary while the page shell is on screen. */
export default function PlainTextPage() {
  return (
    <>
      <PageHeader
        title="Plain text"
        description="Type or paste Khowar text with an optional title and source. Between 20 and 20,000 characters, and only text you wrote or have the right to share."
      />
      <Suspense fallback={<PlainTextSkeleton />}>
        <PlainTextLoader />
      </Suspense>
    </>
  );
}

async function PlainTextLoader() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const page = await getPlainTextPage(user.id, 0);
  return <PlainTextWorkspace initialPage={page} />;
}

function PlainTextSkeleton() {
  return (
    <div className="mt-6 max-w-3xl" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">
          Loading the form and your submissions...
        </p>
      </Card>
    </div>
  );
}
