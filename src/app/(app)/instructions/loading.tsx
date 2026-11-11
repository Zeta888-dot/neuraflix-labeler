import {
  Skeleton,
  SkeletonPageHeader,
  SkeletonTranslationCard,
} from "@/components/ui/skeleton";

export default function InstructionsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the next instruction">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6">
        <Skeleton className="h-3.5 w-40" />
        <div className="mt-4 flex flex-col gap-4">
          <SkeletonTranslationCard fieldHeight="h-32" />
          <SkeletonTranslationCard fieldHeight="h-24" />
        </div>
        <Skeleton className="mt-6 h-14 w-full rounded-lg" />
      </div>
    </div>
  );
}
