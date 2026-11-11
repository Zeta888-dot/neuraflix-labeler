import { SkeletonCard, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the admin overview">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6 flex flex-col gap-4">
        <SkeletonCard lines={3} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={3} />
      </div>
    </div>
  );
}
