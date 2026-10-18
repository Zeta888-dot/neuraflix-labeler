"use client";

import { CaretDown, CaretUp, WarningCircle } from "@phosphor-icons/react";
import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Khowar textarea: RTL, Nastaliq, spellcheck off, a character count and the
 * collapsible "Khowar letters" palette. Insertion happens at the cursor and
 * focus stays in the textarea, so typing is never interrupted.
 */

type PaletteEntry = { char: string; label?: string };

/* Khowar-only letters first, then the common Urdu letters, then ZWNJ. */
const PALETTE: PaletteEntry[] = [
  { char: "\u0681" },
  { char: "\u0685" },
  { char: "\u076E" },
  { char: "\u076F" },
  { char: "\u0770" },
  { char: "\u0771" },
  { char: "\u0679" },
  { char: "\u0688" },
  { char: "\u0691" },
  { char: "\u06BA" },
  { char: "\u06D2" },
  { char: "\u06BE" },
  { char: "\u06C1" },
  { char: "\u06A9" },
  { char: "\u06AF" },
  { char: "\u06CC" },
  { char: "\u0686" },
  { char: "\u067E" },
  { char: "\u0698" },
  { char: "\u06D3" },
  { char: "\u200C", label: "ZWNJ" },
];

function codePoint(char: string): string {
  const value = char.codePointAt(0) ?? 0;
  return `U+${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function KhowarField({
  id,
  label,
  value,
  onChange,
  rows = 4,
  error,
  warning,
  hint,
  disabled,
  fieldRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  error?: string | null;
  warning?: string | null;
  hint?: string;
  disabled?: boolean;
  /** Filled with the textarea so the page can focus the first invalid field. */
  fieldRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Restore the caret after the value changed and React re-rendered the field.
  useEffect(() => {
    if (caretRef.current === null) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const caret = caretRef.current;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    caretRef.current = null;
  }, [value]);

  function insert(char: string) {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? start;
    caretRef.current = start + char.length;
    onChange(value.slice(0, start) + char + value.slice(end));
  }

  const paletteId = `${id}-palette`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const warningId = `${id}-warning`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null, warning ? warningId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  const count = value.length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-body-sm font-medium text-ink">
          {label}
        </label>
        <button
          type="button"
          onClick={() => setPaletteOpen((open) => !open)}
          aria-expanded={paletteOpen}
          aria-controls={paletteId}
          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-caption text-body transition-colors hover:bg-surface-2 hover:text-ink"
        >
          {paletteOpen ? (
            <CaretUp size={14} weight="light" aria-hidden="true" />
          ) : (
            <CaretDown size={14} weight="light" aria-hidden="true" />
          )}
          Khowar letters
        </button>
      </div>

      <textarea
        ref={(node) => {
          textareaRef.current = node;
          if (fieldRef) fieldRef.current = node;
        }}
        id={id}
        name={id}
        rows={rows}
        dir="rtl"
        lang="khw"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "script-nastaliq w-full resize-y rounded-md bg-surface px-3 py-2 text-body-md text-ink",
          "shadow-elev-1 outline-none",
          "transition-colors duration-150 ease-[var(--ease-out-quart)]",
          "hover:border-hairline-strong",
          "disabled:cursor-not-allowed disabled:opacity-60",
          error && "ring-1 ring-error",
        )}
      />

      <div
        id={paletteId}
        role="group"
        aria-label="Khowar letters"
        hidden={!paletteOpen}
        className="flex flex-wrap gap-1.5 rounded-md bg-surface-2 p-2"
      >
        {PALETTE.map((entry) => (
          <button
            key={entry.char}
            type="button"
            title={codePoint(entry.char)}
            aria-label={`Insert ${entry.label ?? entry.char} (${codePoint(entry.char)})`}
            onClick={() => insert(entry.char)}
            className="inline-flex size-11 items-center justify-center rounded-full bg-surface text-ink shadow-elev-1 transition-colors hover:bg-accent-soft hover:text-accent-text"
          >
            {entry.label ? (
              <span className="text-caption">{entry.label}</span>
            ) : (
              <span className="script-nastaliq text-body-md" aria-hidden="true">
                {entry.char}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-mute">
        <span>
          {count} {count === 1 ? "character" : "characters"}
        </span>
        {hint ? <span id={hintId}>{hint}</span> : null}
      </div>

      {error ? (
        <p id={errorId} className="flex items-start gap-1.5 text-caption text-error">
          <WarningCircle
            size={14}
            weight="light"
            aria-hidden="true"
            className="mt-0.5 shrink-0"
          />
          <span>{error}</span>
        </p>
      ) : null}

      {warning ? (
        <p
          id={warningId}
          className="flex items-start gap-1.5 text-caption text-accent-text"
        >
          <WarningCircle
            size={14}
            weight="light"
            aria-hidden="true"
            className="mt-0.5 shrink-0"
          />
          <span>{warning}</span>
        </p>
      ) : null}
    </div>
  );
}
