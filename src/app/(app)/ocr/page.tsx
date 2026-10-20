import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { getSessionUser } from "@/lib/auth";
import { getOcrPagesPage, getOcrStorageStatus } from "@/lib/ocr/ocr-server";
import { OcrMyPages } from "./my-pages";
import { OcrWorkspace } from "./ocr-workspace";

export const metadata: Metadata = {
  title: "OCR pages",
};

/* The header is static. The workspace and the page list need the session, so
   they stream in behind their own boundary while the page shell is on screen. */
export default function OcrPage() {
  return (
    <>
      <PageHeader
        title="OCR pages"
        description="Upload one page image, check the lines, and label them. The full page image never leaves this browser. Only the line images and labels are uploaded."
      />
      <Suspense fallback={<OcrSkeleton />}>
        <OcrLoader />
      </Suspense>
    </>
  );
}

async function OcrLoader() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [initialPage, storageStatus] = await Promise.all([
    getOcrPagesPage(user.id, 0),
    getOcrStorageStatus(),
  ]);

  // A refresh after a submit remounts the list with the new first page.
  const listKey = initialPage
    ? `${initialPage.nextOffset ?? "end"}:${initialPage.items
        .map(
          (item) =>
            `${item.id}:${item.status}:${item.lineCount}:${item.reviewNote ?? ""}`,
        )
        .join("|")}`
    : "unavailable";

  return (
    <>
      <OcrWorkspace userId={user.id} storageStatus={storageStatus} />
      <OcrMyPages key={listKey} initialPage={initialPage} />
    </>
  );
}

function OcrSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">
          Preparing the upload area and your pages...
        </p>
      </Card>
    </div>
  );
}
