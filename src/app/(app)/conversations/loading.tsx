import {
  Skeleton,
  SkeletonPageHeader,
  SkeletonTranslationCard,
} from "@/components/ui/skeleton";

export default function ConversationsLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the next conversation">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6">
        <Skeleton className="h-3.5 w-48" />
        <div className="mt-4 flex flex-col gap-4">
          <SkeletonTranslationCard />
          <SkeletonTranslationCard />
          <SkeletonTranslationCard />
        </div>
        <Skeleton className="mt-6 h-14 w-full rounded-lg" />
      </div>
    </div>
  );
}
