"use client";

import type { RefObject } from "react";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/ui/copy-button";
import { KhowarField } from "@/components/khowar/KhowarField";

/**
 * One read-only English block with its Khowar field directly under it. Shared
 * by Instructions and Conversations so both workspaces keep the same card,
 * spacing, field sizing and mobile stack.
 */
export function TranslationPairCard({
  ariaLabel,
  badge,
  badgeTone = "neutral",
  meta,
  english,
  copyLabel,
  fieldId,
  fieldLabel,
  rows,
  value,
  onChange,
  error,
  warning,
  disabled,
  fieldRef,
}: {
  ariaLabel: string;
  badge: string;
  badgeTone?: "neutral" | "accent";
  meta?: string;
  english: string;
  copyLabel: string;
  fieldId: string;
  fieldLabel: string;
  rows: number;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  warning?: string | null;
  disabled: boolean;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <section
      aria-label={ariaLabel}
      className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={badgeTone}>{badge}</Badge>
          {meta ? <span className="text-caption text-mute">{meta}</span> : null}
        </div>
        <CopyButton value={english} label={copyLabel} />
      </div>

      <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-3 py-2 text-body-md text-ink">
        {english}
      </p>

      <div className="mt-4">
        <KhowarField
          id={fieldId}
          label={fieldLabel}
          rows={rows}
          value={value}
          onChange={onChange}
          error={error}
          warning={warning}
          fieldRef={fieldRef}
          disabled={disabled}
        />
      </div>
    </section>
  );
}
