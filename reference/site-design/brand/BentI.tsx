import { cn } from "@/lib/cn";

/**
 * The bent i: NeuraFlix's signature letterform.
 *
 * Geometry is not eyeballed. It was measured from Sora 600 rendered at 64px and
 * then expressed in units of 1/64em, so the drawing is simply "Sora's i, with a
 * tail". Measured values that drive the numbers below:
 *
 *   x-height (stem ink top)    35 units   -> the i keeps Sora's baseline and
 *                                            height, so it sits with the letters
 *   stem width                  9 units   -> stroke-width, matches Sora 600
 *   i right side bearing      3.7 units   -> air kept after the tail, so the
 *                                            gap before "x" matches Sora
 *
 * Brand adjustments on top of those measurements:
 *   dot diameter   11.7 units  1.3x the stem, so the dot still reads at 16px
 *   dot gap         4.5 units  0.5x the stem, sits close to the stem top
 *   tail: one long cubic sweeping right from y=42 to the tip at x=20, dipping
 *   2 units below the baseline and rising again at the tip, the way "y" does.
 *
 * Three details that are easy to get wrong:
 *   1. Round caps extend half the stroke past the path end, so the stem path
 *      starts at y=21.7 to put the ink top exactly on the x-height line at 17.2.
 *   2. Letter-spacing is NOT applied around an inline SVG, unlike around text.
 *      The drawing is therefore inset inside its box (its leftmost ink and the
 *      3.7 units of air after the tail are what set the box edges) and the box
 *      width is held so the optical gaps around the bent i match plain Sora at
 *      -0.02em tracking. Verified by compositing "NeuraFl" + this glyph + "x"
 *      and comparing the ink gaps against the same word set in plain Sora.
 *   3. The dot is wider than the stem, so the stem is drawn 1 unit right of the
 *      box edge to keep all ink inside the box. Nothing then depends on the SVG
 *      painting outside its viewport.
 *
 * viewBox 0 0 29.1 56, baseline at y=52.2. The drawn box is 0.455em wide and
 * 0.875em tall, sitting 0.059em below the baseline: the tail dips just under
 * it, the way "y" would.
 */
export function BentI({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 29.1 56"
      fill="none"
      /* preflight sets svg { display: block }; the mark needs inline flow so
         `vertical-align` can place the drawn baseline on the text baseline */
      className={cn("inline-block overflow-visible", className)}
      style={{
        width: "0.4546875em",
        height: "0.875em",
        verticalAlign: "-0.059375em",
      }}
    >
      <path
        d="M5.85 21.7V42C5.85 47.8 11.5 51.2 21 49"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* the dot keeps the theme accent even when the rest of the mark
          inherits ink */}
      <circle cx="5.85" cy="6.85" r="5.85" fill="var(--accent)" />
    </svg>
  );
}
