import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { getSessionUser } from "@/lib/auth";
import { OcrWorkspace } from "./ocr-workspace";

export const metadata: Metadata = {
  title: "OCR pages",
};

/* The header is static. The workspace needs the session, so it reads that
   behind its own boundary while the page shell is already on screen. */
export default function OcrPage() {
  return (
    <>
      <PageHeader
        title="OCR pages"
        description="Upload one page image, check the lines, and label them in this browser. The page image and labels stay on this device."
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

  return <OcrWorkspace userId={user.id} />;
}

function OcrSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">
          Preparing the upload area...
        </p>
      </Card>
    </div>
  );
}
