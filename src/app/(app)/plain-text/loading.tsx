import { SkeletonCard, SkeletonPageHeader } from "@/components/ui/skeleton";

export default function PlainTextLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the plain text form">
      <SkeletonPageHeader descriptionLines={2} />
      <div className="mt-6 flex flex-col gap-4">
        <SkeletonCard lines={2} field />
        <SkeletonCard lines={3} />
      </div>
    </div>
  );
}
