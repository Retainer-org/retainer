import Link from "next/link";
import { loadReviewQueue, loadCustomers } from "@/lib/dashboard-data";
import { Empty, PageHeader } from "@/components/dashboard/ui";
import { ReviewCard } from "@/components/dashboard/review-card";
import { reviewWritesEnabled } from "../../../../worker/src/matcher.js";

// The one page in the dashboard that can change anything. Its five actions are
// the only mutations permitted; every other route is read-only.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Review() {
  const [queue, customers] = await Promise.all([loadReviewQueue(), loadCustomers()]);
  const canWrite = reviewWritesEnabled();
  return (
    <>
      <PageHeader
        title="Review queue" reads="db" writes={canWrite}
        sub="Transfers the matcher declined to attribute automatically. It only auto-matches an exact outstanding amount from a sender already linked to a customer; anything less certain waits here with the evidence it weighed. A wrong automatic match is worse than none, because it silently marks a customer paid who has not paid."
        aside={<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{queue.length} awaiting review</span>}
      />
      {!canWrite && (
        <div className="mb-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="text-sm font-semibold text-neutral-900 dark:text-white">Actions are disabled in this public deployment</div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-neutral-700 dark:text-neutral-300">
            This URL has no authentication, so the five review actions are turned off: anyone who can open the page could otherwise alter the
            records they are looking at. Everything below still shows exactly what the matcher decided and why. The write path is gated on an
            environment flag that is unset here and enabled locally, so the engine and the CLI are unaffected.
          </p>
        </div>
      )}

      {queue.length === 0 ? (
        <Empty>
          Nothing awaiting review. Transfers appear here when the evidence is ambiguous — a tie between obligations, an unexpected
          amount, an unrecognised sender, or nothing matching at all.
        </Empty>
      ) : (
        <ul className="space-y-4">
          {queue.map((row) => <ReviewCard key={row.id} row={row} customers={customers} disabled={!canWrite} />)}
        </ul>
      )}
      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Resolutions are recorded with confidence <span className="font-mono">manual</span>, so the audit trail always distinguishes
        what the matcher decided from what a person decided. See <Link href="/docs/failure-modes" className="text-brand-primary hover:underline">the docs</Link> for how classification works.
      </p>
    </>
  );
}
