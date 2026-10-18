import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { requireAppUser } from "@/lib/auth";
import { getInstructionCounts } from "@/lib/instructions-server";

export const metadata: Metadata = {
  title: "Dashboard",
};

const STATUSES = ["draft", "submitted", "approved", "rejected"] as const;

export default async function DashboardPage() {
  const { user } = await requireAppUser();
  const counts = await getInstructionCounts(user.id);
  const total = counts
    ? STATUSES.reduce((sum, status) => sum + counts[status], 0)
    : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your own contribution counts, nothing else. No leaderboard, no project-wide numbers."
      />

      {!counts ? (
        <div className="mt-6">
          <EmptyState title="Counts are not available right now">
            <p>
              The database did not answer. Reload the page in a moment to try
              again.
            </p>
          </EmptyState>
        </div>
      ) : total === 0 ? (
        <div className="mt-6">
          <EmptyState title="No contributions yet">
            <p>
              Counts appear here after your first submission, and they always
              describe this account only.
            </p>
            <p className="mt-3">
              Not sure where to start? Read the Guidelines first, or open
              Instructions and translate your first item.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href="/instructions"
                className={buttonClasses({ size: "sm" })}
              >
                Open Instructions
              </Link>
              <Link
                href="/guidelines"
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Read the Guidelines
              </Link>
            </div>
          </EmptyState>
        </div>
      ) : (
        <Card className="mt-6 max-w-2xl">
          <CardTitle>Instructions</CardTitle>
          <p className="mt-1 text-body-sm text-body">
            Instruction translations you have submitted, by status.
          </p>
          <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {STATUSES.map((status) => (
              <div key={status}>
                <dt className="text-caption capitalize text-mute">{status}</dt>
                <dd className="text-display-sm font-semibold text-ink">
                  {counts[status]}
                </dd>
              </div>
            ))}
          </dl>
          <Link
            href="/instructions"
            className={buttonClasses({ size: "sm" }) + " mt-6"}
          >
            Translate another item
          </Link>
        </Card>
      )}
    </>
  );
}
