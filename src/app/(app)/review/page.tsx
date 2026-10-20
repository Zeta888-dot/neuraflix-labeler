import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { getProfile, getSessionUser } from "@/lib/auth";
import { isReviewKind, type ReviewKind } from "@/lib/review";
import { getReviewQueue } from "@/lib/review-server";
import { ReviewWorkspace } from "./review-workspace";

export const metadata: Metadata = {
  title: "Review",
};

/* The header is static. The queue needs the session and the role, so it reads
   behind a boundary while the page shell is already on screen. */
export default function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <>
      <PageHeader
        title="Review"
        description="Read the submitted work beside its English source, then approve, edit and approve, or reject with a note."
      />
      <Suspense fallback={<ReviewSkeleton />}>
        <ReviewLoader searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function ReviewLoader({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getProfile(user.id);
  if (!profile || (profile.role !== "reviewer" && profile.role !== "admin")) {
    notFound();
  }

  const query = await searchParams;
  const rawKind = Array.isArray(query.kind) ? query.kind[0] : query.kind;
  const kind: ReviewKind = isReviewKind(rawKind) ? rawKind : "instruction";
  const queue = await getReviewQueue(user.id, kind);

  return <ReviewWorkspace initialQueue={queue} initialKind={kind} />;
}

function ReviewSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">Loading the review queues...</p>
      </Card>
    </div>
  );
}
