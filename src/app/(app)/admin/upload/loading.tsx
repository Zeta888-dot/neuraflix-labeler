import { Skeleton, SkeletonCard, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function AdminUploadLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the upload screen">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6 flex flex-col gap-4">
        <SkeletonCard lines={2} field />
        <div className="rounded-lg bg-surface p-6 shadow-elev-2">
          <Skeleton className="h-5 w-40" />
          <div className="mt-4 flex flex-col gap-3">
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
          </div>
        </div>
      </div>
    </div>
  );
}
