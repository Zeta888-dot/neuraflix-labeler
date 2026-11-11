import { Skeleton, SkeletonCard, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function OcrLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the OCR pages workspace">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6 flex flex-col gap-4">
        <div className="rounded-lg bg-surface p-6 shadow-elev-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="mt-4 h-48 w-full rounded-lg" />
          <Skeleton className="mt-4 h-10 w-36" />
        </div>
        <SkeletonCard lines={3} />
      </div>
    </div>
  );
}
