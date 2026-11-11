import { Skeleton, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function AccountLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the account details">
      <SkeletonPageHeader descriptionLines={1} />
      <div className="mt-6 rounded-lg bg-surface p-6 shadow-elev-2">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="mt-4 h-10 w-36 rounded-md" />
        <div className="mt-8 flex flex-col gap-4 border-t border-hairline pt-6">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-56" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
