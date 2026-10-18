"use client";

import { Card, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import type { InstructionItem } from "@/lib/instructions";

/** Read-only English side of the item, one block per part, each copyable. */
export function EnglishPanel({ item }: { item: InstructionItem }) {
  return (
    <Card className="flex flex-col gap-5">
      <CardTitle>English</CardTitle>

      <EnglishBlock
        label="Instruction"
        text={item.english.instruction}
        copyLabel="Copy the English instruction"
      />

      {item.english.input ? (
        <EnglishBlock
          label="Input"
          text={item.english.input}
          copyLabel="Copy the English input"
        />
      ) : null}

      <EnglishBlock
        label="Response"
        text={item.english.response}
        copyLabel="Copy the English response"
      />

      {item.source ? (
        <p className="text-caption text-mute">Source: {item.source}</p>
      ) : null}
    </Card>
  );
}

function EnglishBlock({
  label,
  text,
  copyLabel,
}: {
  label: string;
  text: string;
  copyLabel: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-caption text-mute">{label}</p>
        <CopyButton value={text} label={copyLabel} />
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-body-md text-ink">
        {text}
      </p>
    </div>
  );
}
