import { loadCharges } from "@/lib/dashboard-data";
import { DataTable, Empty, Hash, Note, PageHeader, Pill, fmt } from "@/components/dashboard/ui";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Reconciliation() {
  const snap = await loadCharges();
  const rows = snap.charges.filter((c) => c.attemptSummary.length > 0 || c.state === "confirmed");
  return (
    <>
      <PageHeader title="Reconciliation" sub="A charge is marked paid by the reconciler only — after both SpendPermissionUsed and SpendRouted are indexed for its transaction and the router paid the intended recipient. Never on broadcast, never on receipt alone." />
      <Note>
        <span className="font-mono">
          {snap.indexer
            ? <>indexer at block <b>{snap.indexer.lastIndexedBlock}</b> · chain head <b>{snap.head}</b> · <b>{snap.indexer.lag}</b> blocks behind · last advanced {fmt(snap.indexer.updatedAt)}</>
            : <>indexer has not run yet</>}
        </span>
        <div className="mt-1">The indexer advances when the worker runs. A large lag means the worker is idle, not that money is missing — nothing is marked paid until it catches up.</div>
      </Note>
      {rows.length === 0 ? <Empty>Nothing has been broadcast, so there is nothing to reconcile.</Empty> : (
        <DataTable
          columns={[
            { key: "id", label: "#" }, { key: "attempts", label: "Broadcast attempts (state @ nonce)" }, { key: "mined", label: "Mined" },
            { key: "topics", label: "Both events indexed" }, { key: "at", label: "Confirmed (UTC)" }, { key: "verdict", label: "Verdict" },
          ]}
          rows={rows.map((c) => {
            const mined = c.attemptSummary.some((a) => a.state === "mined_success");
            const verdict = c.state === "confirmed" ? "paid — reconciled on-chain" : mined ? "mined, awaiting reconciliation — NOT yet paid" : "broadcast, not mined — NOT paid";
            return {
              key: c.id,
              cells: {
                id: <>#{c.id}</>,
                attempts: <div className="space-y-0.5">{c.attemptSummary.map((a) => (
                  <div key={a.tx} className="whitespace-nowrap"><span className={a.state === "superseded" ? "text-neutral-400 line-through" : ""}>{a.state}</span> @ {a.nonce} · <Hash value={a.tx} kind="tx" struck={a.state === "superseded"} /></div>
                ))}</div>,
                mined: mined ? <Pill t="good">yes</Pill> : <span className="text-neutral-400">no</span>,
                topics: c.confirmedTx ? (c.topicsIndexed >= 2 ? <Pill t="good">2 / 2</Pill> : <Pill t="bad">{c.topicsIndexed} / 2</Pill>) : <span className="text-neutral-400">—</span>,
                at: <span className="font-sans text-[11px] text-neutral-600 dark:text-neutral-400">{fmt(c.confirmedAt)}</span>,
                verdict: c.state === "confirmed" ? <Pill t="good">{verdict}</Pill> : <span className="font-sans text-xs">{verdict}</span>,
              },
            };
          })}
        />
      )}
    </>
  );
}
