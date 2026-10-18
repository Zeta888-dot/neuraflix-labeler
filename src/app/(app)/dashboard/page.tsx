import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Dashboard",
};

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your own contribution counts, nothing else. No leaderboard, no project-wide numbers."
      />
      <div className="mt-6">
        <EmptyState title="No contributions yet">
          <p>
            Counts appear here after your first submission, and they always
            describe this account only.
          </p>
          <p className="mt-3">
            Not sure where to start? Read the Guidelines first, then pick any
            module from the sidebar.
          </p>
          <Link
            href="/guidelines"
            className={buttonClasses({ variant: "secondary", size: "sm" }) + " mt-4"}
          >
            Read the Guidelines
          </Link>
        </EmptyState>
      </div>
    </>
  );
}
