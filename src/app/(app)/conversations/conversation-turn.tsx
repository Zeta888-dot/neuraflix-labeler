"use client";

import type { RefObject } from "react";
import { TranslationPairCard } from "@/components/translation/translation-pair";
import { roleLabels } from "@/lib/conversations";
import type { ConversationTurn } from "@/lib/khowar";

/**
 * One English turn with its Khowar field directly under it. The shared pair
 * card keeps Conversations and Instructions identical.
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
    <TranslationPairCard
      ariaLabel={`Turn ${index + 1} of ${total}: the English ${label.toLowerCase()} turn and its Khowar text`}
      badge={label}
      badgeTone={turn.role === "user" ? "accent" : "neutral"}
      meta={`Turn ${index + 1} of ${total}`}
      english={turn.content}
      copyLabel={`Copy the English ${label.toLowerCase()} turn`}
      fieldId={`turn-${index + 1}-khowar`}
      fieldLabel={`Khowar ${label.toLowerCase()}`}
      rows={3}
      value={value}
      onChange={onChange}
      error={error}
      warning={warning}
      disabled={disabled}
      fieldRef={fieldRef}
    />
  );
}
