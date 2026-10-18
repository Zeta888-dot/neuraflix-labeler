import type { Metadata } from "next";
import { Check } from "@phosphor-icons/react/dist/ssr";
import { Card, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";

export const metadata: Metadata = {
  title: "Guidelines",
};

const guidelines = [
  "Write natural Khowar, the way a speaker would say it.",
  "Do not machine translate. Translating by hand is the point.",
  "Keep the meaning and the names from the English source.",
  "Use Perso-Arabic script for every Khowar field.",
  "Use the Khowar letters palette for the special letters.",
  "Never include personal data about yourself or anyone else.",
];

export default function GuidelinesPage() {
  return (
    <>
      <PageHeader
        title="Guidelines"
        description="The same short rules apply to every module: instructions, conversations, plain text and OCR labels."
      />
      <Card className="mt-6 max-w-2xl">
        <CardTitle>How to write Khowar here</CardTitle>
        <ul className="mt-4 flex flex-col gap-3">
          {guidelines.map((guideline) => (
            <li key={guideline} className="flex gap-3 text-body-sm text-body">
              <Check
                size={16}
                weight="light"
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-accent-text"
              />
              <span>{guideline}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
