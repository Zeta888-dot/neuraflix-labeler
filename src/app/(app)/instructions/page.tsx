import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page";
import { getSessionUser } from "@/lib/auth";
import { getSubmittedTranslationCount } from "@/lib/instructions-server";
import { InstructionsWorkspace } from "./instructions-workspace";

export const metadata: Metadata = {
  title: "Instructions",
};

export default async function InstructionsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  /* The claim happens in a server action when the workspace loads, so a page
     that is only prefetched never reserves an item. */
  const submitted = await getSubmittedTranslationCount(user.id);

  return (
    <>
      <PageHeader
        title="Instructions"
        description="Translate the English instruction and response pair into Khowar. One item is claimed for you and held for 30 minutes."
      />
      <InstructionsWorkspace initialSubmitted={submitted} />
    </>
  );
}
