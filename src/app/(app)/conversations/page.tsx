import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { getSessionUser } from "@/lib/auth";
import { getSubmittedConversationCount } from "@/lib/conversations-server";
import { ConversationsWorkspace } from "./conversations-workspace";

export const metadata: Metadata = {
  title: "Conversations",
};

/* The header is static. The workspace needs the session, so it reads that
   behind its own boundary while the page shell is already on screen. */
export default function ConversationsPage() {
  return (
    <>
      <PageHeader
        title="Conversations"
        description="Translate a whole English conversation into Khowar, turn by turn. One conversation is claimed for you and held for 30 minutes."
      />
      <Suspense fallback={<ConversationsSkeleton />}>
        <ConversationsWorkspaceLoader />
      </Suspense>
    </>
  );
}

/* The claim happens in a server action when the workspace loads, so a page
   that is only prefetched never reserves a conversation. */
async function ConversationsWorkspaceLoader() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const submitted = await getSubmittedConversationCount(user.id);
  return <ConversationsWorkspace initialSubmitted={submitted} />;
}

/* Same shape as the workspace's own first state, so nothing shifts when the
   session resolves. The workspace keeps the live status announcement. */
function ConversationsSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">
          Finding the next conversation for you...
        </p>
      </Card>
    </div>
  );
}
