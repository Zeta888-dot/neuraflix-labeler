import { Skeleton, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function ReviewLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the review queue">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6 rounded-lg bg-surface p-6 shadow-elev-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9 w-48 rounded-full" />
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-40 w-full rounded-md" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-40 w-full rounded-md" />
          </div>
        </div>
        <Skeleton className="mt-6 h-14 w-full rounded-lg" />
      </div>
    </div>
  );
}
