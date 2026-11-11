import { cn } from "@/lib/cn";

/**
 * Plain Tailwind skeletons. `animate-pulse` is disabled under
 * prefers-reduced-motion through `motion-reduce:animate-none`.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none",
        className,
      )}
    />
  );
}

export function SkeletonLine({
  className,
  width = "w-full",
}: {
  className?: string;
  width?: string;
}) {
  return <Skeleton className={cn("h-3.5", width, className)} />;
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonLine
          key={index}
          width={
            index === lines - 1 && lines > 1
              ? "w-2/3"
              : index % 3 === 2
                ? "w-5/6"
                : "w-full"
          }
        />
      ))}
    </div>
  );
}

/** Header block shaped like PageHeader. */
export function SkeletonPageHeader({ descriptionLines = 2 }: { descriptionLines?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-2">
      <Skeleton className="h-8 w-48" />
      <SkeletonText lines={descriptionLines} className="max-w-[65ch]" />
    </div>
  );
}

/** A card with a title and body lines, the shape most pages use. */
export function SkeletonCard({
  lines = 3,
  className,
  field = false,
}: {
  lines?: number;
  className?: string;
  field?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-lg bg-surface p-6 shadow-elev-2", className)}
    >
      <Skeleton className="h-5 w-40" />
      <SkeletonText lines={lines} className="mt-4" />
      {field ? <Skeleton className="mt-6 h-28 w-full" /> : null}
    </div>
  );
}

/** One English block plus its Khowar field, matching a translation card. */
export function SkeletonTranslationCard({ fieldHeight = "h-28" }: { fieldHeight?: string }) {
  return (
    <div
      aria-hidden="true"
      className="rounded-lg bg-surface p-4 shadow-elev-2 sm:p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-5 w-24 rounded-full" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <Skeleton className="h-7 w-16 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-16 w-full rounded-md" />
      <Skeleton className={cn("mt-4 w-full", fieldHeight)} />
    </div>
  );
}
