"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { reviewDateLabel } from "@/lib/review";
import type { ReviewedOcrPage } from "@/lib/review-server";
import { reopenOcrPage } from "@/app/(app)/review/actions";

/**
 * Admin undo for OCR reviews. Reopening returns the page and its lines to the
 * review queue and keeps a reopen row in review_log.
 */
export function ReopenOcrCard({
  pages: initialPages,
}: {
  pages: ReviewedOcrPage[] | null;
}) {
  const router = useRouter();
  const [pages, setPages] = useState(initialPages);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reopen(page: ReviewedOcrPage) {
    if (pendingId) return;
    setPendingId(page.id);
    setMessage(null);
    setError(null);

    const result = await reopenOcrPage(page.id);
    setPendingId(null);

    if (result.status === "error") {
      setError(result.message);
      return;
    }

    setPages((current) => current?.filter((entry) => entry.id !== page.id) ?? null);
    setMessage("Page reopened. It is back in the OCR review queue.");
    router.refresh();
  }

  return (
    <Card className="max-w-3xl">
      <CardTitle>Reopen an OCR review</CardTitle>
      <p className="mt-1 text-body-sm text-body">
        Approved or rejected pages from the last reviews. Reopening returns the
        page and its lines to the queue, restores the labels the labeler wrote
        and logs the change.
      </p>

      {message ? (
        <p role="status" className="mt-3 text-body-sm text-body">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-body-sm text-error">
          {error}
        </p>
      ) : null}

      {pages === null ? (
        <p className="mt-4 text-body-sm text-error">
          The reviewed pages could not be read. Reload the page in a moment.
        </p>
      ) : pages.length === 0 ? (
        <p className="mt-4 text-body-sm text-mute">
          No OCR pages have been reviewed yet.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col divide-y divide-hairline">
          {pages.map((page) => (
            <li
              key={page.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-body-sm font-medium text-ink">
                  {page.label?.trim() || "Untitled page"}
                </p>
                <p className="text-caption text-mute">
                  {page.lineCount} {page.lineCount === 1 ? "line" : "lines"}
                  {page.reviewedAt
                    ? `, reviewed ${reviewDateLabel(page.reviewedAt)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={page.status === "approved" ? "accent" : "error"}>
                  {page.status === "approved" ? "Approved" : "Rejected"}
                </Badge>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void reopen(page)}
                  disabled={pendingId !== null}
                >
                  {pendingId === page.id ? "Reopening" : "Reopen"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
