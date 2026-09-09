import { loadCharges, type ChargeRow } from "@/lib/dashboard-data";
import { Empty, Hash, PageHeader, fmt } from "@/components/dashboard/ui";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The grouping is the product idea: every failure is classified from chain
// state before any gas is spent, and each class has its own disposition.
export default async function Failures() {
  const { charges } = await loadCharges();
  const failed = charges.filter((c) => c.state.startsWith("failed"));
  const g = {
    terminal: failed.filter((c) => c.state === "failed_terminal"),
    deferred: failed.filter((c) => c.state === "failed_deferred"),
    retrying: failed.filter((c) => c.state === "failed_retryable"),
  };
  return (
    <>
      <PageHeader title="Failed charges" reads="db" sub="Classified before broadcast, so none of these cost gas. Terminal will not retry; deferred retries at the time shown; retrying backs off." aside={<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{failed.length} failed</span>} />
      {failed.length === 0 ? <Empty>No failed charges.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Group title="Terminal — will not retry" note="Revoked or expired. The permission is gone; nothing the engine does can bring it back." rows={g.terminal} ring="ring-red-500/30" showNext={false} />
          <Group title="Deferred — retries at a known time" note="Allowance exhausted, not yet started, or not yet registered. Retrying sooner is pure waste, so the engine waits for the instant it can succeed." rows={g.deferred} ring="ring-neutral-400/30" showNext />
          <Group title="Retrying — with backoff" note="Insufficient balance. A reverted charge consumes no allowance, so retrying is safe against the cap; it is capped by gas instead." rows={g.retrying} ring="ring-amber-500/30" showNext />
        </div>
      )}
    </>
  );
}

function Group({ title, note, rows, ring, showNext }: { title: string; note: string; rows: ChargeRow[]; ring: string; showNext: boolean }) {
  return (
    <div className={`rounded-2xl bg-white p-5 shadow-sm ring-1 dark:bg-neutral-900 ${ring}`}>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">{title} <span className="ml-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">{rows.length}</span></h2>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{note}</p>
      {rows.length === 0 ? <p className="mt-4 text-xs text-neutral-400">none</p> : (
        <ul className="mt-4 space-y-3">
          {rows.map((c) => (
            <li key={c.id} className="rounded-lg bg-neutral-50 p-3 font-mono text-xs dark:bg-neutral-800/60">
              <div className="flex items-center justify-between gap-2"><span>charge #{c.id}</span><span className="font-semibold">{c.lastFailure}</span></div>
              <div className="mt-1 break-words text-neutral-600 dark:text-neutral-400">{c.failureDetail}</div>
              <div className="mt-1 text-neutral-500 dark:text-neutral-400">permission <Hash value={c.permissionHash} /></div>
              <div className="mt-1 text-neutral-500 dark:text-neutral-400">
                attempts {c.attempts}
                {showNext && c.nextAttemptAt && <> · next attempt <span className="text-neutral-800 dark:text-neutral-200">{fmt(c.nextAttemptAt)}</span></>}
                {!showNext && <> · no further attempts</>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
