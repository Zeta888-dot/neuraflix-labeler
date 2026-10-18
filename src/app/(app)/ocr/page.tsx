import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "OCR pages",
};

export default function OcrPage() {
  return (
    <>
      <PageHeader
        title="OCR pages"
        description="Upload one page image, segment it into lines in your browser, then label each line. The original page image is never uploaded or stored."
      />
      <div className="mt-6">
        <EmptyState title="No pages yet">
          <p>
            This module is not open yet. Line crops will be prepared locally,
            kept in your browser while you work, and uploaded only when you
            submit.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
