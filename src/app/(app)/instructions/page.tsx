import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Instructions",
};

export default function InstructionsPage() {
  return (
    <>
      <PageHeader
        title="Instructions"
        description="Translate English instruction and response pairs into Khowar. One item is claimed for you at a time."
      />
      <div className="mt-6">
        <EmptyState title="Nothing to translate yet">
          <p>
            This module is not open yet. Once it ships you will see the English
            item on the left and the Khowar fields on the right, with autosaved
            drafts.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
