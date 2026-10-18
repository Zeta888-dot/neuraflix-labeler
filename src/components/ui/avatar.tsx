import { cn } from "@/lib/cn";

/** Initials from a display name or email, for the avatar circle. */
function initials(value: string): string {
  const parts = value.trim().split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Avatar({
  name,
  size = 32,
  className,
}: {
  /** Display name or email. */
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        "bg-surface-2 text-caption font-medium text-body",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}
