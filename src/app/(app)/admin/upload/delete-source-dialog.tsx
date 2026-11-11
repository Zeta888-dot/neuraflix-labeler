"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ImportDeletePreview,
  ImportDeleteResult,
  ImportSource,
  ImportSourceItem,
} from "@/lib/admin/upload/types";
import {
  deleteImportItemAction,
  deleteImportSourceAction,
  getImportDeletePreviewAction,
  getImportSourceItemsAction,
} from "./actions";

type Busy = "load" | "source" | "item" | null;

function countLabel(value: number, singular: string, plural = `${singular}s`) {
  return `${value.toLocaleString("en")} ${value === 1 ? singular : plural}`;
}

/**
 * Confirm and delete the items one import source added. Safe items go first;
 * items with translations, claims or review records need the extra checkbox
 * and a typed confirmation.
 */
export function DeleteSourceDialog({
  source,
  onClose,
  onChanged,
}: {
  source: ImportSource;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const confirmId = useId();

  const [preview, setPreview] = useState<ImportDeletePreview | null>(null);
  const [items, setItems] = useState<ImportSourceItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState<Busy>("load");
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [includeWork, setIncludeWork] = useState(false);
  const [confirm, setConfirm] = useState("");

  const pageSize = 50;
  const confirmText = confirm.trim();
  const confirmMatches =
    !includeWork ||
    confirmText === "DELETE" ||
    (preview !== null && confirmText === preview.fileName);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function load(nextOffset = 0, append = false): Promise<void> {
    setBusy("load");
    setError(null);
    setNote(null);

    const [previewResult, itemsResult] = await Promise.all([
      getImportDeletePreviewAction({ sourceId: source.id }),
      getImportSourceItemsAction({
        sourceId: source.id,
        offset: nextOffset,
        limit: pageSize,
      }),
    ]);

    if (previewResult.status === "error") {
      setError(previewResult.message);
      setBusy(null);
      return;
    }

    setPreview(previewResult.preview);
    setOffset(nextOffset);
    setHasMore(
      itemsResult.status === "ok" && itemsResult.rows.length === pageSize,
    );

    if (itemsResult.status === "ok") {
      setItems((current) =>
        append ? [...current, ...itemsResult.rows] : itemsResult.rows,
      );
    } else {
      setError(itemsResult.message);
    }

    setBusy(null);
  }

  useEffect(() => {
    // Deferred so the first paint is not blocked by the count queries.
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
    // The source id is fixed for this mounted dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDeleteSource(): Promise<void> {
    if (!preview || !confirmMatches) return;
    setBusy("source");
    setError(null);
    setNote(null);

    const result = await deleteImportSourceAction({
      sourceId: source.id,
      includeWork,
      confirm: confirmText,
    });

    if (result.status === "error") {
      setError(result.message);
      setBusy(null);
      return;
    }

    await onChanged();

    if (result.result.sourceRemoved) {
      onClose();
      return;
    }

    setBusy(null);
    setNote(deleteSummary(result.result));
    setIncludeWork(false);
    setConfirm("");
    await load();
  }

  async function handleDeleteItem(item: ImportSourceItem): Promise<void> {
    if (!preview) return;
    if (includeWork && !confirmMatches) return;
    if (!item.canDelete && !includeWork) return;

    setBusyItemId(item.itemId);
    setError(null);
    setNote(null);

    const result = await deleteImportItemAction({
      kind: preview.kind,
      itemId: item.itemId,
      includeWork,
      confirm: confirmText,
    });

    if (result.status === "error") {
      setError(result.message);
      setBusyItemId(null);
      return;
    }

    await onChanged();

    if (result.result.sourceRemoved) {
      onClose();
      return;
    }

    setBusyItemId(null);
    setNote(deleteSummary(result.result));
    setIncludeWork(false);
    setConfirm("");
    await load();
  }

  const pending = busy !== null || busyItemId !== null;
  const protectedItems = preview?.protectedItems ?? 0;
  const canDeleteAnything =
    (preview?.safeItems ?? 0) > 0 || (includeWork && protectedItems > 0);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-lg bg-surface p-6 text-ink shadow-elev-5 backdrop:bg-black/50"
    >
      <h2 id={titleId} className="text-display-sm font-semibold">
        Delete imported items
      </h2>
      <p id={descriptionId} className="mt-2 text-body-sm text-body">
        {source.fileName}. Safe deletion removes only open items with no
        translations, claims or review records. Anything with labeler work
        stays unless you choose to delete submitted work too.
      </p>

      {busy === "load" && !preview ? (
        <p className="mt-5 text-body-sm text-mute">Loading the item counts...</p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 text-body-sm text-error">
          {error}
        </p>
      ) : null}

      {note ? (
        <p role="status" className="mt-4 rounded-md bg-surface-2 p-3 text-body-sm text-body">
          {note}
        </p>
      ) : null}

      {preview ? (
        <>
          <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-caption text-mute">Items</dt>
              <dd className="text-body-sm font-semibold text-ink">
                {preview.totalItems.toLocaleString("en")}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-mute">Safe to delete</dt>
              <dd className="text-body-sm font-semibold text-ink">
                {preview.safeItems.toLocaleString("en")}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-mute">Has labeler work</dt>
              <dd className="text-body-sm font-semibold text-ink">
                {preview.protectedItems.toLocaleString("en")}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-mute">Exported translations</dt>
              <dd className="text-body-sm font-semibold text-ink">
                {preview.exportedItems.toLocaleString("en")}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-caption text-mute">
            {countLabel(preview.translatedItems, "item")} with translations,{" "}
            {countLabel(preview.claimedItems, "item")} with a claim,{" "}
            {countLabel(preview.reviewedItems, "item")} with a review record.
          </p>

          {protectedItems > 0 ? (
            <div className="mt-5 rounded-md bg-surface-2/60 p-4">
              <label className="flex items-start gap-3 text-body-sm text-ink">
                <input
                  type="checkbox"
                  checked={includeWork}
                  onChange={(event) => {
                    setIncludeWork(event.target.checked);
                    setConfirm("");
                  }}
                  disabled={busy !== null}
                  className="mt-0.5 size-4"
                />
                <span>
                  Also delete submitted work. This removes{" "}
                  {countLabel(preview.translatedItems, "translation")},{" "}
                  {countLabel(preview.reviewedItems, "review record")} and{" "}
                  {countLabel(preview.claimedItems, "claim")}. Deleted data
                  cannot be restored.
                </span>
              </label>

              {includeWork ? (
                <div className="mt-3">
                  <label
                    htmlFor={confirmId}
                    className="text-caption text-mute"
                  >
                    Type DELETE or the exact file name to confirm
                  </label>
                  <Input
                    id={confirmId}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="mt-1"
                    disabled={busy !== null}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
            <p className="text-caption text-mute">
              {includeWork
                ? "Safe items and protected items will both be deleted."
                : `${countLabel(preview.safeItems, "safe item")} will be deleted. ${countLabel(protectedItems, "protected item")} stay.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={onClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                onClick={() => void handleDeleteSource()}
                disabled={pending || !canDeleteAnything || !confirmMatches}
              >
                {busy === "source"
                  ? "Deleting..."
                  : includeWork
                    ? "Delete all items and work"
                    : "Delete safe items"}
              </Button>
            </div>
          </div>

          <div className="mt-6">
            <h3 className="text-body-sm font-medium text-ink">
              Items in this import
            </h3>
            {items.length === 0 ? (
              <p className="mt-2 text-body-sm text-mute">
                This source has no items left.
              </p>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {items.map((item) => (
                  <li
                    key={item.itemId}
                    className="rounded-md bg-surface-2/60 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="line-clamp-2 text-body-sm text-ink">
                          {item.preview || "No English preview"}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-caption text-mute">
                          <Badge tone={item.status === "open" ? "accent" : "neutral"}>
                            {item.status}
                          </Badge>
                          <span>
                            {countLabel(item.translationCount, "translation")},{" "}
                            {countLabel(item.claimCount, "claim")},{" "}
                            {countLabel(item.reviewCount, "review")}
                          </span>
                          {item.exportedCount > 0 ? (
                            <span className="text-accent-text">
                              {countLabel(item.exportedCount, "exported")}
                            </span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {!item.canDelete ? (
                          <span className="text-caption text-mute">Protected</span>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={
                            pending ||
                            busyItemId === item.itemId ||
                            (includeWork && !confirmMatches) ||
                            (!item.canDelete && !includeWork)
                          }
                          onClick={() => void handleDeleteItem(item)}
                        >
                          {busyItemId === item.itemId ? "Deleting..." : "Delete"}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {hasMore ? (
              <div className="mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => void load(offset + pageSize, true)}
                >
                  Load more items
                </Button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

function deleteSummary(result: ImportDeleteResult): string {
  const parts = [
    countLabel(result.deletedItems, "item"),
    countLabel(result.deletedTranslations, "translation"),
    countLabel(result.deletedExported, "exported translation"),
    countLabel(result.deletedClaims, "claim"),
    countLabel(result.deletedReviews, "review record"),
  ];

  const remaining =
    result.remainingItems > 0
      ? ` ${countLabel(result.remainingItems, "item")} remain in this source.`
      : "";

  return `Deleted ${parts.join(", ")}.${remaining}`;
}
