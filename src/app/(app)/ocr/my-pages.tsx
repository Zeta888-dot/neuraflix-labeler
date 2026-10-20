"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  OCR_PAGE_SIZE,
  ocrStatusLabels,
  ocrStatusTones,
  type OcrPagesPage,
  type OcrPageSummary,
} from "@/lib/ocr/pages";
import { loadMoreOcrPages } from "./actions";

/** The contributor's own OCR pages, newest first, 20 at a time. */
export function OcrMyPages({
  initialPage,
}: {
  initialPage: OcrPagesPage | null;
}) {
  const [items, setItems] = useState<OcrPageSummary[]>(
    initialPage?.items ?? [],
  );
  const [nextOffset, setNextOffset] = useState<number | null>(
    initialPage?.nextOffset ?? null,
  );
  const [listError, setListError] = useState<string | null>(
    initialPage === null ? "Your pages could not be loaded right now." : null,
  );
  const [busy, setBusy] = useState(false);

  async function loadMore() {
    if (nextOffset === null || busy) return;
    setBusy(true);
    setListError(null);

    const result = await loadMoreOcrPages(nextOffset);
    setBusy(false);

    if (result.status === "error") {
      setListError(result.message);
      return;
    }

    setItems((current) => {
      const known = new Set(current.map((item) => item.id));
      return [
        ...current,
        ...result.page.items.filter((item) => !known.has(item.id)),
      ];
    });
    setNextOffset(result.page.nextOffset);
  }

  return (
    <section
      id="my-pages"
      aria-labelledby="my-pages-heading"
      className="mt-8 scroll-mt-24"
    >
      <Card className="p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2
              id="my-pages-heading"
              className="text-display-sm font-semibold text-ink"
            >
              My pages
            </h2>
            <p className="mt-1 max-w-[65ch] text-body-sm text-body">
              Pages you have submitted, newest first. Approved and rejected
              pages stay here with the reviewer note.
            </p>
          </div>
          {items.length > 0 ? (
            <p className="text-caption tabular-nums text-mute">
              {items.length} shown
            </p>
          ) : null}
        </div>

        {initialPage === null && items.length === 0 ? (
          <div className="mt-4 rounded-md bg-surface-2 px-4 py-6">
            <p className="text-body-md font-medium text-ink">
              Your pages are not available right now
            </p>
            <p className="mt-1 text-body-sm text-body">
              Reload the page in a moment to try again.
            </p>
          </div>
        ) : items.length === 0 ? (
          <div className="mt-4 rounded-md bg-surface-2 px-4 py-6">
            <p className="text-body-md font-medium text-ink">
              No OCR pages yet
            </p>
            <p className="mt-1 max-w-[65ch] text-body-sm text-body">
              When you submit a page, it appears here with its line count and
              status.
            </p>
          </div>
        ) : (
          <ol className="mt-4 flex flex-col gap-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-md bg-surface-2 px-3 py-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-body-md font-medium text-ink">
                      {item.label ?? "Untitled page"}
                    </p>
                    <p className="mt-0.5 text-caption text-mute">
                      {item.createdLabel},{" "}
                      {item.lineCount === 1
                        ? "1 line"
                        : `${item.lineCount.toLocaleString("en")} lines`}
                    </p>
                  </div>
                  <Badge tone={ocrStatusTones[item.status]}>
                    {ocrStatusLabels[item.status]}
                  </Badge>
                </div>

                {item.status === "rejected" && item.reviewNote ? (
                  <div className="mt-2 rounded-xs bg-surface px-2.5 py-2">
                    <p className="text-caption font-medium text-ink">
                      Reviewer note
                    </p>
                    <p className="mt-0.5 break-words text-body-sm text-body">
                      {item.reviewNote}
                    </p>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        {listError ? (
          <p role="alert" className="mt-3 text-body-sm text-error">
            {listError}
          </p>
        ) : null}

        {nextOffset !== null && items.length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            className="mt-4 h-11 sm:h-10"
            onClick={() => void loadMore()}
            disabled={busy}
          >
            {busy ? "Loading..." : `Load more pages`}
          </Button>
        ) : null}

        {items.length >= OCR_PAGE_SIZE && nextOffset === null ? (
          <p className="mt-3 text-caption text-mute">
            That is every page on this account so far.
          </p>
        ) : null}
      </Card>
    </section>
  );
}
