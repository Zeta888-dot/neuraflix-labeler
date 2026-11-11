import {
  SkeletonCard,
  SkeletonPageHeader,
} from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-label="Loading the dashboard">
      <SkeletonPageHeader />
      <div className="mt-6 flex flex-col gap-4">
        {Array.from({ length: 5 }, (_, index) => (
          <SkeletonCard key={index} lines={2} />
        ))}
      </div>
    </div>
  );
}
