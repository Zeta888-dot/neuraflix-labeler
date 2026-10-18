import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Review",
};

export default function ReviewPage() {
  return (
    <>
      <PageHeader
        title="Review"
        description="Approve, edit and approve, or reject submitted work with a note."
      />
      <div className="mt-6">
        <EmptyState title="Nothing to review yet">
          <p>
            This module is not open yet. Submissions appear here as soon as
            contributors start sending work, oldest first.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
