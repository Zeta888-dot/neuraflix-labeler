import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/page";
import { CopyButton } from "@/components/ui/copy-button";
import { requireAppUser } from "@/lib/auth";
import {
  getInstructionItemCounts,
  type InstructionItemCounts,
} from "@/lib/instructions-server";

export const metadata: Metadata = {
  title: "Admin",
};

const ITEM_STATUSES = ["open", "complete", "retired"] as const;

const IMPORT_COMMAND =
  "npm run import:english -- --file samples/english-instructions.sample.jsonl --source sample --target-count 1";

const IMPORT_USAGE =
  "npm run import:english -- --file path.jsonl --source name --target-count 1 [--dry-run]";

const JSONL_EXAMPLE =
  '{"instruction":"Say hello in a friendly way.","response":"Hello! It is good to see you."}';

export default async function AdminPage() {
  const { profile } = await requireAppUser();
  if (profile.role !== "admin") notFound();

  const counts: InstructionItemCounts | null = await getInstructionItemCounts();

  return (
    <>
      <PageHeader
        title="Admin"
        description="Admin only. Counts come from the database and the import runs as a local script."
      />

      <div className="mt-6 flex flex-col gap-4">
        <Card className="max-w-3xl">
          <CardTitle>Instruction items</CardTitle>
          <p className="mt-1 text-body-sm text-body">
            Every imported English item, by status. An item turns complete once
            submitted and approved translations reach its target count.
          </p>

          {counts ? (
            <dl className="mt-5 grid grid-cols-3 gap-4">
              {ITEM_STATUSES.map((status) => (
                <div key={status}>
                  <dt className="text-caption capitalize text-mute">{status}</dt>
                  <dd className="text-display-sm font-semibold text-ink">
                    {counts[status]}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-4 text-body-sm text-error">
              The counts could not be read. Reload the page in a moment.
            </p>
          )}
        </Card>

        <Card className="max-w-3xl">
          <CardTitle>Import English items</CardTitle>
          <p className="mt-1 text-body-sm text-body">
            Run this in the project folder. It reads the service role key from
            .env.local, and nothing in the web app can import items.
          </p>

          <div className="mt-4 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-caption text-ink">
              {IMPORT_COMMAND}
            </code>
            <CopyButton
              value={IMPORT_COMMAND}
              label="Copy the import command"
              className="-my-1 shrink-0"
            />
          </div>

          <div className="mt-4 flex flex-col gap-3 text-body-sm text-body">
            <div>
              <p className="text-caption text-mute">Usage</p>
              <code className="mt-1 block break-all font-mono text-caption text-ink">
                {IMPORT_USAGE}
              </code>
            </div>
            <div>
              <p className="text-caption text-mute">One JSON object per line</p>
              <code className="mt-1 block break-all font-mono text-caption text-ink">
                {JSONL_EXAMPLE}
              </code>
              <p className="mt-1">
                instruction and response are required, input is optional, and
                output works as an alias of response. Duplicates are skipped by
                hash, in batches of 200.
              </p>
            </div>
          </div>
        </Card>

        <EmptyState title="Export and sync stay local" className="max-w-3xl">
          <p>
            They run as scripts under scripts/ with the service role key, never
            from this page.
          </p>
        </EmptyState>
      </div>
    </>
  );
}
