"use client";

import { useState } from "react";
import { KhowarField } from "@/components/khowar/KhowarField";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { roleLabels } from "@/lib/conversations";
import type {
  ConversationTurn,
  EnglishSource,
  InstructionTranslationValues,
  KhowarFieldErrors,
} from "@/lib/khowar";
import {
  buildAutoChecks,
  countCharactersIn,
  reviewKindSingular,
  type AutoCheck,
  type ReviewConversationItem,
  type ReviewInstructionItem,
  type ReviewOcrItem,
  type ReviewOcrLine,
  type ReviewTextItem,
} from "@/lib/review";
import { cn } from "@/lib/cn";

/** Presentational review cards. All editable state lives in the workspace. */

export type OcrDraftLine = ReviewOcrLine & {
  originalLabel: string;
  reject: boolean;
  error: string | null;
};

export function AutoCheckList({ checks }: { checks: AutoCheck[] }) {
  return (
    <div className="mt-4 rounded-md bg-surface-2 px-3 py-2">
      <p className="text-caption font-medium text-body">Automatic checks</p>
      {checks.length === 0 ? (
        <p className="mt-1 text-caption text-mute">No automatic warnings.</p>
      ) : (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-caption text-body">
          {checks.map((check) => (
            <li key={check.id}>{check.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemHeading({
  title,
  item,
  source,
}: {
  title: string;
  item: { kind: string; createdLabel: string; source?: string | null };
  source?: string | null;
}) {
  const detail = [
    source ?? null,
    `Submitted ${item.createdLabel}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <CardTitle>{title}</CardTitle>
        <p className="mt-1 text-caption text-mute">{detail}</p>
      </div>
      <Badge>Submitted</Badge>
    </div>
  );
}

function EnglishSourceBlock({ english }: { english: EnglishSource }) {
  return (
    <section aria-label="English source">
      <h3 className="text-body-sm font-semibold text-ink">English</h3>
      <div className="mt-3 flex flex-col gap-4">
        <div>
          <p className="text-caption text-mute">Instruction</p>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-3 py-2 text-body-md text-ink">
            {english.instruction}
          </p>
        </div>
        {english.input ? (
          <div>
            <p className="text-caption text-mute">Input</p>
            <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-3 py-2 text-body-md text-ink">
              {english.input}
            </p>
          </div>
        ) : null}
        <div>
          <p className="text-caption text-mute">Response</p>
          <p className="mt-1 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-3 py-2 text-body-md text-ink">
            {english.response}
          </p>
        </div>
      </div>
    </section>
  );
}

export function InstructionReviewCard({
  item,
  values,
  errors,
  disabled,
  onChange,
}: {
  item: ReviewInstructionItem;
  values: InstructionTranslationValues;
  errors: KhowarFieldErrors;
  disabled: boolean;
  onChange: (field: keyof InstructionTranslationValues, value: string) => void;
}) {
  return (
    <Card>
      <ItemHeading
        title="Instruction translation"
        item={item}
        source={item.source}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <EnglishSourceBlock english={item.english} />

        <section aria-label="Khowar translation">
          <h3 className="text-body-sm font-semibold text-ink">Khowar</h3>
          <div className="mt-3 flex flex-col gap-4">
            <KhowarField
              id="review-instruction"
              label="Khowar instruction"
              rows={3}
              value={values.khowar_instruction}
              onChange={(value) => onChange("khowar_instruction", value)}
              error={errors.khowar_instruction}
              disabled={disabled}
            />
            {item.english.input ? (
              <KhowarField
                id="review-input"
                label="Khowar input"
                rows={2}
                value={values.khowar_input}
                onChange={(value) => onChange("khowar_input", value)}
                error={errors.khowar_input}
                disabled={disabled}
              />
            ) : null}
            <KhowarField
              id="review-response"
              label="Khowar response"
              rows={3}
              value={values.khowar_response}
              onChange={(value) => onChange("khowar_response", value)}
              error={errors.khowar_response}
              disabled={disabled}
            />
          </div>
        </section>
      </div>

      <AutoCheckList
        checks={buildAutoChecks("instruction", values, item.english)}
      />
    </Card>
  );
}

export function ConversationReviewCard({
  item,
  turns,
  errors,
  disabled,
  onChange,
}: {
  item: ReviewConversationItem;
  turns: ConversationTurn[];
  errors: Record<number, string>;
  disabled: boolean;
  onChange: (index: number, value: string) => void;
}) {
  return (
    <Card>
      <ItemHeading
        title="Conversation translation"
        item={item}
        source={item.source}
      />

      <div className="mt-6 flex flex-col gap-5">
        {item.english.turns.map((turn, index) => {
          const label = roleLabels[turn.role];
          const translated = turns[index];

          return (
            <section
              key={`${turn.role}-${index}`}
              aria-label={`Turn ${index + 1} of ${item.english.turns.length}: English ${label.toLowerCase()} and Khowar`}
              className="grid gap-4 rounded-lg bg-surface-2/60 p-4 lg:grid-cols-2"
            >
              <div>
                <div className="flex items-center gap-2">
                  <Badge tone={turn.role === "user" ? "accent" : "neutral"}>
                    {label}
                  </Badge>
                  <span className="text-caption text-mute">
                    Turn {index + 1} of {item.english.turns.length}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap break-words text-body-md text-ink">
                  {turn.content}
                </p>
              </div>

              <KhowarField
                id={`review-turn-${index + 1}`}
                label={`Khowar ${label.toLowerCase()}`}
                rows={3}
                value={translated?.content ?? ""}
                onChange={(value) => onChange(index, value)}
                error={errors[index]}
                disabled={disabled}
              />
            </section>
          );
        })}
      </div>

      <AutoCheckList
        checks={buildAutoChecks(
          "conversation",
          turns,
          item.english,
        )}
      />
    </Card>
  );
}

export function TextReviewCard({
  item,
  text,
  error,
  disabled,
  onChange,
}: {
  item: ReviewTextItem;
  text: string;
  error: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Card>
      <ItemHeading title="Plain text submission" item={item} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <section aria-label="Submission details">
          <h3 className="text-body-sm font-semibold text-ink">Details</h3>
          <dl className="mt-3 flex flex-col gap-3 text-body-sm">
            <div>
              <dt className="text-caption text-mute">Title</dt>
              <dd className="text-ink">{item.title ?? "No title"}</dd>
            </div>
            <div>
              <dt className="text-caption text-mute">Source note</dt>
              <dd className="whitespace-pre-wrap break-words text-ink">
                {item.sourceNote ?? "No source note"}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-mute">Characters</dt>
              <dd className="tabular-nums text-ink">
                {countCharactersIn(text).toLocaleString("en")}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-label="Khowar text">
          <h3 className="text-body-sm font-semibold text-ink">Khowar text</h3>
          <div className="mt-3">
            <KhowarField
              id="review-text"
              label="Khowar text"
              rows={14}
              value={text}
              onChange={onChange}
              error={error}
              disabled={disabled}
            />
          </div>
        </section>
      </div>

      <AutoCheckList checks={buildAutoChecks("text", text)} />
    </Card>
  );
}

export function OcrReviewCard({
  item,
  lines,
  disabled,
  retrying,
  onChange,
  onToggleReject,
  onRetryImages,
}: {
  item: ReviewOcrItem;
  lines: OcrDraftLine[];
  disabled: boolean;
  retrying: boolean;
  onChange: (idx: number, label: string) => void;
  onToggleReject: (idx: number) => void;
  onRetryImages: () => Promise<boolean>;
}) {
  const [zoom, setZoom] = useState(100);
  const [failed, setFailed] = useState<Set<number>>(new Set());
  const kept = lines.filter((line) => !line.reject).length;

  async function retryLine() {
    const ok = await onRetryImages();
    if (!ok) return;
    setFailed(new Set());
  }

  return (
    <Card>
      <ItemHeading
        title="OCR page"
        item={{
          kind: item.kind,
          createdLabel: item.createdLabel,
        }}
      />
      <p className="mt-2 text-body-sm text-body">
        {item.pageLabel ?? "Untitled page"} · {item.lineCount}{" "}
        {item.lineCount === 1 ? "line" : "lines"} · {kept} kept
      </p>

      <div className="mt-5 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-body-sm text-ink">
          Image zoom
          <input
            type="range"
            min={50}
            max={200}
            step={10}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="h-11 w-48 accent-[var(--accent)]"
          />
        </label>
        <span className="pb-2 text-caption tabular-nums text-mute">
          {zoom} percent
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-5">
        {lines.length === 0 ? (
          <p className="rounded-md bg-surface-2 px-4 py-6 text-body-sm text-body">
            No line images were found for this page. Reject the page and ask the
            contributor to submit it again.
          </p>
        ) : null}

        {lines.map((line) => (
          <section
            key={line.id}
            aria-label={`Line ${line.idx}`}
            className={cn(
              "grid gap-4 rounded-lg p-4",
              "bg-surface-2/60 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]",
              line.reject && "opacity-60",
            )}
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-caption font-medium text-body">
                  Line {line.idx}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-11"
                  aria-pressed={line.reject}
                  onClick={() => onToggleReject(line.idx)}
                  disabled={disabled}
                >
                  {line.reject ? "Restore line" : "Remove line"}
                </Button>
              </div>

              <div className="mt-2 max-h-[28rem] overflow-auto rounded-md bg-canvas p-2">
                {line.imageUrl && !failed.has(line.idx) ? (
                  // Signed private images from Storage, never optimised by Next.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={line.imageUrl}
                    alt={`Cropped line ${line.idx}`}
                    className="h-auto max-w-none"
                    style={{ width: `${zoom}%` }}
                    loading="lazy"
                    onError={() =>
                      setFailed((current) => {
                        const next = new Set(current);
                        next.add(line.idx);
                        return next;
                      })
                    }
                  />
                ) : (
                  <div className="flex flex-col items-start gap-2 px-2 py-6">
                    <p className="text-body-sm text-body">
                      The image for line {line.idx} could not be loaded.
                    </p>
                    {!line.reject ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-11"
                        onClick={() => void retryLine()}
                        disabled={disabled || retrying}
                      >
                        {retrying ? "Signing again" : "Retry image"}
                      </Button>
                    ) : null}
                  </div>
                )}
              </div>
            </div>

            <div>
              <KhowarField
                id={`review-ocr-line-${line.idx}`}
                label={`Khowar label for line ${line.idx}`}
                singleLine
                value={line.label}
                onChange={(value) => onChange(line.idx, value)}
                error={line.error}
                disabled={disabled || line.reject}
              />
              {line.reject ? (
                <p className="mt-2 text-caption text-mute">
                  This line will be rejected with the page.
                </p>
              ) : null}
              <AutoCheckList checks={buildAutoChecks("ocr", line.label)} />
            </div>
          </section>
        ))}
      </div>

      <p className="mt-4 text-caption text-mute">
        {reviewKindSingular.ocr} images are signed for one hour. If one expires,
        use Retry image.
      </p>
    </Card>
  );
}
