import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { requireAppUser } from "@/lib/auth";
import { getConversationCounts } from "@/lib/conversations-server";
import { getInstructionCounts } from "@/lib/instructions-server";

export const metadata: Metadata = {
  title: "Dashboard",
};

const STATUSES = ["draft", "submitted", "approved", "rejected"] as const;

type StatusCounts = Record<(typeof STATUSES)[number], number>;

export default async function DashboardPage() {
  const { user } = await requireAppUser();
  const [instructionCounts, conversationCounts] = await Promise.all([
    getInstructionCounts(user.id),
    getConversationCounts(user.id),
  ]);

  const instructionTotal = instructionCounts
    ? STATUSES.reduce((sum, status) => sum + instructionCounts[status], 0)
    : 0;
  const conversationTotal = conversationCounts
    ? STATUSES.reduce((sum, status) => sum + conversationCounts[status], 0)
    : 0;
  const bothKnown = instructionCounts !== null && conversationCounts !== null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your own contribution counts, nothing else. No leaderboard, no project-wide numbers."
      />

      {!instructionCounts && !conversationCounts ? (
        <div className="mt-6">
          <EmptyState title="Counts are not available right now">
            <p>
              The database did not answer. Reload the page in a moment to try
              again.
            </p>
          </EmptyState>
        </div>
      ) : bothKnown && instructionTotal === 0 && conversationTotal === 0 ? (
        <div className="mt-6">
          <EmptyState title="No contributions yet">
            <p>
              Counts appear here after your first submission, and they always
              describe this account only.
            </p>
            <p className="mt-3">
              Not sure where to start? Read the Guidelines first, or open
              Instructions or Conversations and translate your first item.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link
                href="/instructions"
                className={buttonClasses({ size: "sm" })}
              >
                Open Instructions
              </Link>
              <Link
                href="/conversations"
                className={buttonClasses({ size: "sm" })}
              >
                Open Conversations
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
        <div className="mt-6 flex flex-col gap-4">
          <CountsCard
            title="Instructions"
            description="Instruction translations you have submitted, by status."
            href="/instructions"
            cta="Translate another item"
            counts={instructionCounts}
            total={instructionTotal}
            emptyNote="No instruction translations yet."
          />
          <CountsCard
            title="Conversations"
            description="Conversation translations you have submitted, by status."
            href="/conversations"
            cta="Translate another conversation"
            counts={conversationCounts}
            total={conversationTotal}
            emptyNote="No conversation translations yet."
          />
        </div>
      )}
    </>
  );
}

function CountsCard({
  title,
  description,
  href,
  cta,
  counts,
  total,
  emptyNote,
}: {
  title: string;
  description: string;
  href: string;
  cta: string;
  counts: StatusCounts | null;
  total: number;
  emptyNote: string;
}) {
  return (
    <Card className="max-w-2xl">
      <CardTitle>{title}</CardTitle>
      <p className="mt-1 text-body-sm text-body">{description}</p>

      {counts ? (
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
      ) : (
        <p className="mt-4 text-body-sm text-error">
          These counts could not be read. Reload the page in a moment.
        </p>
      )}

      {counts && total === 0 ? (
        <p className="mt-4 text-body-sm text-mute">{emptyNote}</p>
      ) : null}

      <Link href={href} className={buttonClasses({ size: "sm" }) + " mt-6"}>
        {cta}
      </Link>
    </Card>
  );
}
