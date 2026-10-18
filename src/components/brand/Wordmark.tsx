import { BentI } from "@/components/brand/BentI";
import { cn } from "@/lib/cn";

/**
 * Text-only wordmark: "NeuraFl" + the bent i + "x". No logo mark, no icon.
 *
 * Layout is intentional inline text flow (not flex), because `vertical-align`
 * is what aligns the inline SVG to the text baseline. `aria-label` carries the
 * real spelling, so assistive tech reads "NeuraFlix" rather than "NeuraFlx".
 */
export function Wordmark({
  size = 20,
  className,
}: {
  /** Font size in px. The SVG scales with it. */
  size?: number;
  className?: string;
}) {
  return (
    <span
      role="img"
      aria-label="NeuraFlix"
      className={cn(
        "inline-block whitespace-nowrap font-wordmark font-semibold text-ink",
        "tracking-[-0.02em] leading-[1.1]",
        className,
      )}
      style={{ fontSize: size }}
    >
      <span aria-hidden>NeuraFl</span>
      <BentI />
      {/* The bent i is a glyph, not a letter, so the DOM has no "i" to read.
          This keeps the rendered text ("NeuraFlix") matching the accessible
          name; screen readers still use the aria-label above. */}
      <span className="sr-only">i</span>
      <span aria-hidden>x</span>
    </span>
  );
}

/**
 * The app lockup: the wordmark plus the muted word "Labeler" next to it.
 */
export function LabelerWordmark({
  size = 20,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <Wordmark size={size} />
      <span
        className="text-body-sm text-mute"
        style={{ fontSize: Math.max(12, size - 6) }}
      >
        Labeler
      </span>
    </span>
  );
}
