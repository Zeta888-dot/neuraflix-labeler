"use client";

import type { RefObject } from "react";
import { TranslationPairCard } from "@/components/translation/translation-pair";
import type { InstructionItem } from "@/lib/instructions";
import type {
  InstructionTranslationValues,
  KhowarFieldErrors,
} from "@/lib/khowar";

type Values = InstructionTranslationValues;
type Field = keyof Values;
type Refs = Record<Field, RefObject<HTMLTextAreaElement | null>>;

/**
 * The instruction rendered like the conversation turns: each part is one card
 * with the English text on top and its Khowar field below.
 */
export function InstructionParts({
  item,
  values,
  errors,
  fieldWarnings,
  disabled,
  fieldRefs,
  onChange,
}: {
  item: InstructionItem;
  values: Values;
  errors: KhowarFieldErrors;
  fieldWarnings: KhowarFieldErrors;
  disabled: boolean;
  fieldRefs: Refs;
  onChange: (field: Field, value: string) => void;
}) {
  const parts: Array<{
    field: Field;
    badge: string;
    english: string;
    rows: number;
  }> = [
    {
      field: "khowar_instruction",
      badge: "Instruction",
      english: item.english.instruction,
      rows: 4,
    },
  ];

  if (item.english.input) {
    parts.push({
      field: "khowar_input",
      badge: "Input",
      english: item.english.input,
      rows: 3,
    });
  }

  parts.push({
    field: "khowar_response",
    badge: "Response",
    english: item.english.response,
    rows: 4,
  });

  const total = parts.length;

  return (
    <>
      <div className="mt-4 flex flex-col gap-4">
        {parts.map((part, index) => (
          <TranslationPairCard
            key={part.field}
            ariaLabel={`Part ${index + 1} of ${total}: the English ${part.badge.toLowerCase()} and its Khowar text`}
            badge={part.badge}
            meta={`Part ${index + 1} of ${total}`}
            english={part.english}
            copyLabel={`Copy the English ${part.badge.toLowerCase()}`}
            fieldId={part.field}
            fieldLabel={`Khowar ${part.badge.toLowerCase()}`}
            rows={part.rows}
            value={values[part.field]}
            onChange={(value) => onChange(part.field, value)}
            error={errors[part.field]}
            warning={fieldWarnings[part.field]}
            disabled={disabled}
            fieldRef={fieldRefs[part.field]}
          />
        ))}
      </div>

      {item.source ? (
        <p className="mt-3 text-caption text-mute">Source: {item.source}</p>
      ) : null}
    </>
  );
}
