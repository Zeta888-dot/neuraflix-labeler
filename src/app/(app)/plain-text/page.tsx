import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Plain text",
};

export default function PlainTextPage() {
  return (
    <>
      <PageHeader
        title="Plain text"
        description="Type or paste Khowar text with an optional title and source note. Between 20 and 20,000 characters, after confirming you have the right to share it."
      />
      <div className="mt-6">
        <EmptyState title="No text submitted yet">
          <p>
            This module is not open yet. Validation runs before you submit, and
            identical text is deduplicated by a hash.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
