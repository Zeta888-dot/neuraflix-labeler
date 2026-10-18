import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { getSessionUser } from "@/lib/auth";
import { getSubmittedTranslationCount } from "@/lib/instructions-server";
import { InstructionsWorkspace } from "./instructions-workspace";

export const metadata: Metadata = {
  title: "Instructions",
};

/* The header is static. The workspace needs the session, so it reads that
   behind its own boundary while the page shell is already on screen. */
export default function InstructionsPage() {
  return (
    <>
      <PageHeader
        title="Instructions"
        description="Translate the English instruction and response pair into Khowar. One item is claimed for you and held for 30 minutes."
      />
      <Suspense fallback={<InstructionsSkeleton />}>
        <InstructionsWorkspaceLoader />
      </Suspense>
    </>
  );
}

/* The claim happens in a server action when the workspace loads, so a page
   that is only prefetched never reserves an item. */
async function InstructionsWorkspaceLoader() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const submitted = await getSubmittedTranslationCount(user.id);
  return <InstructionsWorkspace initialSubmitted={submitted} />;
}

/* Same shape as the workspace's own first state, so nothing shifts when the
   session resolves. The workspace keeps the live status announcement. */
function InstructionsSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">Finding the next item for you...</p>
      </Card>
    </div>
  );
}
