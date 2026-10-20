import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState, PageHeader } from "@/components/ui/page";
import type { AdminOverview } from "@/lib/admin";
import { getAdminData } from "@/lib/admin-server";
import { getProfile, getSessionUser } from "@/lib/auth";
import { getConversationItemCounts } from "@/lib/conversations-server";
import { getInstructionItemCounts } from "@/lib/instructions-server";
import { getOcrAdminStats, getOcrStorageStatus } from "@/lib/ocr/ocr-server";
import {
  OCR_LINE_STATUSES,
  OCR_PAGE_STATUSES,
  ocrLineStatusLabels,
  ocrStatusLabels,
  type OcrStorageStatus,
} from "@/lib/ocr/pages";
import { decideQuota } from "@/lib/ocr/submit";
import { TEXT_SUBMISSION_STATUSES } from "@/lib/plain-text";
import { getPlainTextAdminStats } from "@/lib/plain-text-server";
import { AdminUsers } from "./admin-users";

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

const CONVERSATION_IMPORT_COMMAND =
  "npm run import:conversations -- --file samples/english-conversations.sample.jsonl --source sample --target-count 1";

const CONVERSATION_IMPORT_USAGE =
  "npm run import:conversations -- --file path.jsonl --source name --target-count 1 [--dry-run]";

const CONVERSATION_JSONL_EXAMPLE =
  '{"turns":[{"role":"user","content":"Where can I buy a bus ticket?"},{"role":"assistant","content":"You can buy one at the station counter or on the bus from the driver."}]}';

const SYNC_COMMAND = "npm run sync";

const megabytes = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

/* The header is static. The session, the role check and every count happen
   behind the boundary, so the admin shell is on screen immediately. */
export default function AdminPage() {
  return (
    <>
      <PageHeader
        title="Admin"
        description="Admin only. Counts come from the database and the import runs as a local script."
      />
      <Suspense fallback={<AdminSkeleton />}>
        <AdminLoader />
      </Suspense>
    </>
  );
}

async function AdminLoader() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const profile = await getProfile(user.id);
  if (!profile || profile.role !== "admin") notFound();

  const [
    adminData,
    counts,
    conversationCounts,
    plainTextStats,
    ocrStats,
    ocrStorage,
  ] = await Promise.all([
    getAdminData(),
    getInstructionItemCounts(),
    getConversationItemCounts(),
    getPlainTextAdminStats(),
    getOcrAdminStats(),
    getOcrStorageStatus(),
  ]);

  return (
    <div className="mt-6 flex flex-col gap-4">
      <AdminOverviewCard overview={adminData.overview} />
      <AdminUsers users={adminData.users} currentUserId={user.id} />

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

      <Card className="max-w-3xl">
        <CardTitle>Conversation items</CardTitle>
        <p className="mt-1 text-body-sm text-body">
          Every imported English conversation, by status. A conversation turns
          complete once submitted and approved translations reach its target
          count.
        </p>

        {conversationCounts ? (
          <dl className="mt-5 grid grid-cols-3 gap-4">
            {ITEM_STATUSES.map((status) => (
              <div key={status}>
                <dt className="text-caption capitalize text-mute">{status}</dt>
                <dd className="text-display-sm font-semibold text-ink">
                  {conversationCounts[status]}
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
        <CardTitle>Import English conversations</CardTitle>
        <p className="mt-1 text-body-sm text-body">
          Run this in the project folder. It reads the service role key from
          .env.local, and nothing in the web app can import conversations.
        </p>

        <div className="mt-4 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-caption text-ink">
            {CONVERSATION_IMPORT_COMMAND}
          </code>
          <CopyButton
            value={CONVERSATION_IMPORT_COMMAND}
            label="Copy the conversations import command"
            className="-my-1 shrink-0"
          />
        </div>

        <div className="mt-4 flex flex-col gap-3 text-body-sm text-body">
          <div>
            <p className="text-caption text-mute">Usage</p>
            <code className="mt-1 block break-all font-mono text-caption text-ink">
              {CONVERSATION_IMPORT_USAGE}
            </code>
          </div>
          <div>
            <p className="text-caption text-mute">One JSON object per line</p>
            <code className="mt-1 block break-all font-mono text-caption text-ink">
              {CONVERSATION_JSONL_EXAMPLE}
            </code>
            <p className="mt-1">
              turns is required and messages works as an alias. Roles are
              system, user and assistant: at least 2 turns, at most 20, an
              optional system turn first, then user and assistant alternating,
              starting with user and ending with assistant. Duplicates are
              skipped by hash, in batches of 200.
            </p>
          </div>
        </div>
      </Card>

      <Card className="max-w-3xl">
        <CardTitle>Plain text submissions</CardTitle>
        <p className="mt-1 text-body-sm text-body">
          Every plain text submission, by status, and the total characters
          stored. A new submission starts as submitted.
        </p>

        {plainTextStats ? (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {TEXT_SUBMISSION_STATUSES.map((status) => (
                <div key={status}>
                  <dt className="text-caption capitalize text-mute">
                    {status}
                  </dt>
                  <dd className="text-display-sm font-semibold text-ink">
                    {plainTextStats[status]}
                  </dd>
                </div>
              ))}
              <div>
                <dt className="text-caption text-mute">Total characters</dt>
                <dd className="text-display-sm font-semibold text-ink">
                  {plainTextStats.characters.toLocaleString("en")}
                </dd>
              </div>
            </dl>

            {plainTextStats.submitted +
              plainTextStats.approved +
              plainTextStats.rejected ===
            0 ? (
              <p className="mt-4 text-body-sm text-mute">
                No text has been submitted yet.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-4 text-body-sm text-error">
            The counts could not be read. Reload the page in a moment.
          </p>
        )}
      </Card>

      <Card className="max-w-3xl">
        <CardTitle>OCR pages and lines</CardTitle>
        <p className="mt-1 text-body-sm text-body">
          Every OCR page and line, by status. Incomplete pages are uploads
          that were started but never finalized.
        </p>

        {ocrStats ? (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-5">
              {OCR_PAGE_STATUSES.map((status) => (
                <div key={status}>
                  <dt className="text-caption text-mute">
                    {ocrStatusLabels[status]}
                  </dt>
                  <dd className="text-display-sm font-semibold text-ink">
                    {ocrStats.pages[status]}
                  </dd>
                </div>
              ))}
            </dl>

            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-hairline pt-4 sm:grid-cols-4">
              {OCR_LINE_STATUSES.map((status) => (
                <div key={status}>
                  <dt className="text-caption text-mute">
                    {ocrLineStatusLabels[status]} lines
                  </dt>
                  <dd className="text-display-sm font-semibold text-ink">
                    {ocrStats.lines[status]}
                  </dd>
                </div>
              ))}
            </dl>

            {OCR_PAGE_STATUSES.every(
              (status) => ocrStats.pages[status] === 0,
            ) ? (
              <p className="mt-4 text-body-sm text-mute">
                No OCR pages have been uploaded yet.
              </p>
            ) : null}
          </>
        ) : (
          <p className="mt-4 text-body-sm text-error">
            The OCR counts could not be read. Reload the page in a moment.
          </p>
        )}
      </Card>

      <OcrStorageCard storage={ocrStorage} />

      <Card className="max-w-3xl">
        <CardTitle>Sync reviewed OCR output</CardTitle>
        <p className="mt-1 text-body-sm text-body">
          This command is not part of the app. It will run locally under
          scripts/ with the service role key, never from this page.
        </p>
        <div className="mt-4 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2">
          <code className="min-w-0 flex-1 break-all font-mono text-caption text-ink">
            {SYNC_COMMAND}
          </code>
          <CopyButton
            value={SYNC_COMMAND}
            label="Copy the sync command"
            className="-my-1 shrink-0"
          />
        </div>
        <p className="mt-2 text-caption text-mute">
          Available in a later update.
        </p>
      </Card>

      <EmptyState title="Export and sync stay local" className="max-w-3xl">
        <p>
          They run as scripts under scripts/ with the service role key, never
          from this page.
        </p>
      </EmptyState>
    </div>
  );
}

function AdminOverviewCard({ overview }: { overview: AdminOverview | null }) {
  if (!overview) {
    return (
      <Card className="max-w-3xl">
        <CardTitle>Overview</CardTitle>
        <p className="mt-4 text-body-sm text-error">
          The overview could not be read. Reload the page in a moment.
        </p>
      </Card>
    );
  }

  const instructionTotal = totalOf(overview.instruction);
  const conversationTotal = totalOf(overview.conversation);
  const textTotal = totalOf(overview.text);
  const ocrPageTotal = totalOf(overview.ocrPages);
  const itemTotal =
    instructionTotal + conversationTotal + textTotal + ocrPageTotal;

  return (
    <Card className="max-w-3xl">
      <CardTitle>Overview</CardTitle>
      <p className="mt-1 text-body-sm text-body">
        Every contribution and account at a glance. All numbers come from the
        database.
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <OverviewStat label="Instruction translations" value={instructionTotal} />
        <OverviewStat
          label="Conversation translations"
          value={conversationTotal}
        />
        <OverviewStat label="Plain text submissions" value={textTotal} />
        <OverviewStat label="OCR pages" value={ocrPageTotal} />
        <OverviewStat label="OCR lines" value={totalOf(overview.ocrLines)} />
        <OverviewStat
          label="Contributors active in 30 days"
          value={overview.recentContributors}
        />
      </dl>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-hairline pt-4 sm:grid-cols-4">
        <OverviewStat
          label="Contributors"
          value={overview.users.contributor ?? 0}
        />
        <OverviewStat label="Reviewers" value={overview.users.reviewer ?? 0} />
        <OverviewStat label="Admins" value={overview.users.admin ?? 0} />
        <OverviewStat label="All accounts" value={overview.users.total ?? 0} />
      </dl>

      {itemTotal === 0 && overview.ocrLines.approved === 0 ? (
        <p className="mt-4 text-body-sm text-mute">
          No contributions have been made yet.
        </p>
      ) : null}
    </Card>
  );
}

function OverviewStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-caption text-mute">{label}</dt>
      <dd className="text-display-sm font-semibold tabular-nums text-ink">
        {value.toLocaleString("en")}
      </dd>
    </div>
  );
}

function totalOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0);
}

function AdminSkeleton() {
  return (
    <div className="mt-6" aria-hidden="true">
      <Card className="mt-4">
        <p className="text-body-sm text-mute">Loading the admin counts...</p>
      </Card>
    </div>
  );
}

function OcrStorageCard({ storage }: { storage: OcrStorageStatus | null }) {
  if (!storage) {
    return (
      <Card className="max-w-3xl">
        <CardTitle>OCR storage</CardTitle>
        <p className="mt-4 text-body-sm text-error">
          The storage status could not be read. Reload the page in a moment.
        </p>
      </Card>
    );
  }

  const decision = decideQuota(storage.usedBytes, storage.quotaBytes, 0);
  const usedMb = storage.usedBytes / 1048576;
  const quotaMb = storage.quotaBytes / 1048576;
  const percent =
    storage.quotaBytes <= 0
      ? 0
      : Math.min(
          100,
          Math.round((storage.usedBytes / storage.quotaBytes) * 100),
        );
  const tone =
    decision === "block" ? "error" : decision === "warn" ? "accent" : "neutral";
  const statusLabel =
    decision === "block"
      ? "Uploads blocked"
      : decision === "warn"
        ? "Quota warning"
        : "Storage ok";

  return (
    <Card className="max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <CardTitle>OCR storage</CardTitle>
        <Badge tone={tone}>{statusLabel}</Badge>
      </div>
      <p className="mt-1 text-body-sm text-body">
        Encoded line images in the private bucket, against the quota in
        app_settings.
      </p>

      <dl className="mt-5 grid grid-cols-3 gap-4">
        <div>
          <dt className="text-caption text-mute">Used</dt>
          <dd className="text-display-sm font-semibold text-ink">
            {megabytes.format(usedMb)} MB
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Quota</dt>
          <dd className="text-display-sm font-semibold text-ink">
            {megabytes.format(quotaMb)} MB
          </dd>
        </div>
        <div>
          <dt className="text-caption text-mute">Share</dt>
          <dd className="text-display-sm font-semibold text-ink">
            {percent} percent
          </dd>
        </div>
      </dl>

      <div
        role="progressbar"
        aria-label="OCR storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent} percent, ${megabytes.format(usedMb)} MB of ${megabytes.format(quotaMb)} MB`}
        className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className={
            decision === "block"
              ? "h-full rounded-full bg-error"
              : "h-full rounded-full bg-accent"
          }
          style={{ width: `${percent}%` }}
        />
      </div>

      <p className="mt-3 text-body-sm text-body">
        {decision === "block"
          ? "Above 80 percent. New OCR uploads are blocked. Plain text, instructions and conversations still work."
          : decision === "warn"
            ? "At or above 60 percent. New OCR uploads still work, but the quota is filling."
            : "Under 60 percent. New OCR uploads are accepted."}
      </p>
    </Card>
  );
}
