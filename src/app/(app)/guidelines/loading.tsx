import { SkeletonCard, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function GuidelinesLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the guidelines">
      <SkeletonPageHeader descriptionLines={2} />
      <SkeletonCard className="mt-6" lines={6} />
    </div>
  );
}
