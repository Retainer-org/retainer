import Link from "next/link";
import { loadReviewQueue, loadCustomers } from "@/lib/dashboard-data";
import { Empty, PageHeader } from "@/components/dashboard/ui";
import { ReviewCard } from "@/components/dashboard/review-card";

// The one page in the dashboard that can change anything. Its five actions are
// the only mutations permitted; every other route is read-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Review() {
  const [queue, customers] = await Promise.all([loadReviewQueue(), loadCustomers()]);
  return (
    <>
      <PageHeader
        title="Review queue"
        sub="Transfers the matcher declined to attribute automatically. It only auto-matches an exact outstanding amount from a sender already linked to a customer; anything less certain waits here with the evidence it weighed. A wrong automatic match is worse than none, because it silently marks a customer paid who has not paid."
        aside={<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{queue.length} awaiting review</span>}
      />
      {queue.length === 0 ? (
        <Empty>
          Nothing awaiting review. Transfers appear here when the evidence is ambiguous — a tie between obligations, an unexpected
          amount, an unrecognised sender, or nothing matching at all.
        </Empty>
      ) : (
        <ul className="space-y-4">
          {queue.map((row) => <ReviewCard key={row.id} row={row} customers={customers} />)}
        </ul>
      )}
      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Resolutions are recorded with confidence <span className="font-mono">manual</span>, so the audit trail always distinguishes
        what the matcher decided from what a person decided. See <Link href="/docs/failure-modes" className="text-brand-primary hover:underline">the docs</Link> for how classification works.
      </p>
    </>
  );
}
