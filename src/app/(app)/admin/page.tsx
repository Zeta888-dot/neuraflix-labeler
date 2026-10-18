import type { Metadata } from "next";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Admin",
};

export default function AdminPage() {
  return (
    <>
      <PageHeader
        title="Admin"
        description="Import English datasets, manage user roles, and watch counts and storage."
      />
      <div className="mt-6">
        <EmptyState title="Nothing to manage yet">
          <p>
            This module is not open yet. Export and sync stay as local scripts
            and are never run from the web app.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
