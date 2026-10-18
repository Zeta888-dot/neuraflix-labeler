import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Conversations",
};

export default function ConversationsPage() {
  return (
    <>
      <PageHeader
        title="Conversations"
        description="Multi-turn English conversations translated turn by turn into Khowar."
      />
      <div className="mt-6">
        <EmptyState title="Nothing to translate yet">
          <p>
            This module is not open yet. Each English turn will sit above its
            own Khowar field, with one submission for the whole conversation.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
