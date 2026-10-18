import { cn } from "@/lib/cn";

/**
 * The bent i: NeuraFlix's signature letterform.
 *
 * Geometry is not eyeballed. It was measured from Sora 600 rendered at 64px and
 * then expressed in units of 1/64em, so the drawing is simply "Sora's i, with a
 * tail".
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
