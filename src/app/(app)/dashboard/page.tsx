import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { requireAppUser } from "@/lib/auth";
import { getConversationCounts } from "@/lib/conversations-server";
import { getInstructionCounts } from "@/lib/instructions-server";
import { getOcrCounts } from "@/lib/ocr/ocr-server";
import {
  OCR_PAGE_STATUSES,
  ocrStatusLabels,
  type OcrCounts,
} from "@/lib/ocr/pages";
import { getPlainTextCounts } from "@/lib/plain-text-server";
import { getMyFeedback } from "@/lib/review-server";
import type { FeedbackItem } from "@/lib/review";

export const metadata: Metadata = {
  title: "Dashboard",
};

const STATUSES = ["draft", "submitted", "approved", "rejected"] as const;
const TEXT_STATUSES = ["submitted", "approved", "rejected"] as const;

type StatusKey = (typeof STATUSES)[number];
type Counts = Partial<Record<StatusKey, number>>;

export default async function DashboardPage() {
  const { user } = await requireAppUser();
  const [
    instructionCounts,
    conversationCounts,
    plainTextCounts,
    ocrCounts,
    feedback,
  ] = await Promise.all([
    getInstructionCounts(user.id),
    getConversationCounts(user.id),
    getPlainTextCounts(user.id),
    getOcrCounts(user.id),
    getMyFeedback(10),
  ]);

  const instructionTotal = instructionCounts
    ? STATUSES.reduce((sum, status) => sum + instructionCounts[status], 0)
    : 0;
  const conversationTotal = conversationCounts
    ? STATUSES.reduce((sum, status) => sum + conversationCounts[status], 0)
    : 0;
  const plainTextTotal = plainTextCounts
    ? TEXT_STATUSES.reduce((sum, status) => sum + plainTextCounts[status], 0)
    : 0;
  const ocrTotal = ocrCounts
    ? OCR_PAGE_STATUSES.reduce((sum, status) => sum + ocrCounts.pages[status], 0)
    : 0;
  const allKnown =
    instructionCounts !== null &&
    conversationCounts !== null &&
    plainTextCounts !== null &&
    ocrCounts !== null;
  const allTotals =
    instructionTotal + conversationTotal + plainTextTotal + ocrTotal;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Your own contribution counts, nothing else. No leaderboard, no project-wide numbers."
      />

      {!instructionCounts &&
      !conversationCounts &&
      !plainTextCounts &&
      !ocrCounts ? (
        <div className="mt-6">
          <EmptyState title="Counts are not available right now">
            <p>
              The database did not answer. Reload the page in a moment to try
              again.
            </p>
          </EmptyState>
        </div>
      ) : allKnown && allTotals === 0 ? (
        <div className="mt-6">
          <EmptyState title="No contributions yet">
            <p>
              Counts appear here after your first submission, and they always
              describe this account only.
            </p>
            <p className="mt-3">
              Not sure where to start? Read the Guidelines first, or open
              Instructions, Conversations, Plain text or OCR pages to start.
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
                href="/plain-text"
                className={buttonClasses({ size: "sm" })}
              >
                Open Plain text
              </Link>
              <Link href="/ocr" className={buttonClasses({ size: "sm" })}>
                Open OCR pages
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
          <CountsCard
            title="Plain text"
            description="Plain text submissions you have sent, by status."
            href="/plain-text"
            cta="Submit plain text"
            statuses={TEXT_STATUSES}
            counts={plainTextCounts}
            total={plainTextTotal}
            emptyNote="No plain text submitted yet."
          />
          <OcrCountsCard counts={ocrCounts} total={ocrTotal} />
          <FeedbackCard feedback={feedback} />
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
  statuses = STATUSES,
}: {
  title: string;
  description: string;
  href: string;
  cta: string;
  counts: Counts | null;
  total: number;
  emptyNote: string;
  statuses?: readonly StatusKey[];
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mt-1 text-body-sm text-body">{description}</p>

      {counts ? (
        <dl
          className={`mt-5 grid grid-cols-2 gap-4 ${
            statuses.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4"
          }`}
        >
          {statuses.map((status) => (
            <div key={status}>
              <dt className="text-caption capitalize text-mute">{status}</dt>
              <dd className="text-display-sm font-semibold text-ink">
                {counts[status] ?? 0}
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

function FeedbackCard({ feedback }: { feedback: FeedbackItem[] | null }) {
  return (
    <Card>
      <CardTitle>Reviewer feedback</CardTitle>
      <p className="mt-1 text-body-sm text-body">
        Rejected or reviewer-edited contributions, newest first. The note is
        written by the reviewer.
      </p>

      {feedback === null ? (
        <p className="mt-4 text-body-sm text-error">
          Your feedback could not be read. Reload the page in a moment.
        </p>
      ) : feedback.length === 0 ? (
        <p className="mt-4 text-body-sm text-mute">
          No reviewer feedback yet.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {feedback.map((item) => (
            <li
              key={`${item.kind}:${item.id}`}
              className="rounded-md bg-surface-2/60 p-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={item.status === "rejected" ? "error" : "neutral"}>
                  {item.status === "rejected" ? "Rejected" : "Approved"}
                </Badge>
                <span className="text-caption text-mute">
                  {item.kindLabel} · {item.reviewedLabel}
                </span>
                {item.reviewerEdited ? (
                  <span className="text-caption text-accent-text">
                    Edited by a reviewer
                  </span>
                ) : null}
              </div>

              {item.preview ? (
                <p
                  dir="rtl"
                  lang="khw"
                  className="script-nastaliq mt-2 break-words text-body-md text-ink"
                >
                  {item.preview}
                </p>
              ) : null}

              {item.reviewNote ? (
                <p className="mt-2 whitespace-pre-wrap break-words text-body-sm text-body">
                  Reviewer note: {item.reviewNote}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OcrCountsCard({
  counts,
  total,
}: {
  counts: OcrCounts | null;
  total: number;
}) {
  return (
    <Card>
      <CardTitle>OCR pages</CardTitle>
      <p className="mt-1 text-body-sm text-body">
        Your OCR pages, by status, and the lines uploaded from them.
      </p>

      {counts ? (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
            {OCR_PAGE_STATUSES.map((status) => (
              <div key={status}>
                <dt className="text-caption text-mute">
                  {ocrStatusLabels[status]}
                </dt>
                <dd className="text-display-sm font-semibold text-ink">
                  {counts.pages[status]}
                </dd>
              </div>
            ))}
            <div>
              <dt className="text-caption text-mute">Lines uploaded</dt>
              <dd className="text-display-sm font-semibold text-ink">
                {counts.lines.toLocaleString("en")}
              </dd>
            </div>
          </dl>

          {total === 0 ? (
            <p className="mt-4 text-body-sm text-mute">
              No OCR pages yet.
            </p>
          ) : null}
        </>
      ) : (
        <p className="mt-4 text-body-sm text-error">
          These counts could not be read. Reload the page in a moment.
        </p>
      )}

      <Link href="/ocr" className={buttonClasses({ size: "sm" }) + " mt-6"}>
        {total === 0 ? "Submit an OCR page" : "Open OCR pages"}
      </Link>
    </Card>
  );
}
