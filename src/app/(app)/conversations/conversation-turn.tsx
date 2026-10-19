"use client";

import type { RefObject } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { Badge } from "@/components/ui/badge";
import { KhowarField } from "@/components/khowar/KhowarField";
import { roleLabels } from "@/lib/conversations";
import type { ConversationTurn } from "@/lib/khowar";

/**
 * One English turn with its Khowar field directly under it. Both live in one
 * group, so the English block and the field that translates it always read as
 * a pair, on mobile and on desktop.
 */
export function ConversationTurnCard({
  index,
  total,
  turn,
  value,
  error,
  warning,
  disabled,
  fieldRef,
  onChange,
}: {
  index: number;
  total: number;
  turn: ConversationTurn;
  value: string;
  error?: string | null;
  warning?: string | null;
  disabled: boolean;
  fieldRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
}) {
  const label = roleLabels[turn.role];

  return (
    <section
      aria-label={`Turn ${index + 1} of ${total}: the English ${label.toLowerCase()} turn and its Khowar text`}
      className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={turn.role === "user" ? "accent" : "neutral"}>{label}</Badge>
          <span className="text-caption text-mute">
            Turn {index + 1} of {total}
          </span>
        </div>
        <CopyButton
          value={turn.content}
          label={`Copy the English ${label.toLowerCase()} turn`}
        />
      </div>

      <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-surface-2 px-3 py-2 text-body-md text-ink">
        {turn.content}
      </p>

      <div className="mt-4">
        <KhowarField
          id={`turn-${index + 1}-khowar`}
          label={`Khowar ${label.toLowerCase()}`}
          rows={3}
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
