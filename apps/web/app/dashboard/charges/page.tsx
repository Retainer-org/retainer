import Link from "next/link";
import { loadSnapshot } from "@/lib/dashboard-data";
import { DataTable, Empty, Hash, Note, PageHeader, Pill, StatePill, fmt, usdc } from "@/components/dashboard/ui";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// This page is the ledger of charges that were actually attempted. Charges that
// failed pre-flight -- never broadcast, no gas spent -- live on /failures with
// their disposition, so each charge appears in exactly one place.
export default async function Charges() {
  const { charges } = await loadSnapshot();
  const attempted = charges.filter((c) => !c.state.startsWith("failed"));
  const failed = charges.length - attempted.length;
  return (
    <>
      <PageHeader title="Charges" sub="Requested is what the engine asked for; settled is what the on-chain SpendRouted event says moved. They must match."
        aside={<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{attempted.length} attempted · {attempted.filter((c) => c.state === "confirmed").length} confirmed</span>} />
      {failed > 0 && <Note>{failed} charge{failed === 1 ? "" : "s"} failed before broadcast and {failed === 1 ? "is" : "are"} listed with {failed === 1 ? "its" : "their"} classification on <Link href="/dashboard/failures" className="text-brand-primary hover:underline">Failures</Link>, not here.</Note>}
      {attempted.length === 0 ? <Empty>No charges have been attempted.</Empty> : (
        <DataTable
          columns={[
            { key: "id", label: "#" }, { key: "perm", label: "Permission" }, { key: "kind", label: "Amount" },
            { key: "req", label: "Requested", align: "right" }, { key: "settled", label: "Settled on-chain", align: "right" },
            { key: "state", label: "State" }, { key: "tx", label: "Transaction" }, { key: "when", label: "Confirmed (UTC)" },
          ]}
          rows={attempted.map((c) => ({
            key: c.id,
            cells: {
              id: <>#{c.id}</>,
              perm: <Hash value={c.permissionHash} />,
              kind: c.amountSource === "usage" ? <Pill t="brand" title={c.usageNote ?? undefined}>usage · computed at charge time</Pill> : <Pill t="muted">fixed</Pill>,
              req: usdc(c.requested),
              settled: c.settled ? <>{usdc(c.settled)} {c.settled === c.requested ? <Pill t="good">match</Pill> : <Pill t="bad">mismatch</Pill>}</> : <span className="text-neutral-400">—</span>,
              state: <StatePill state={c.state} />,
              tx: c.confirmedTx ? <Hash value={c.confirmedTx} kind="tx" /> : <span className="text-neutral-400">none</span>,
              when: <span className="font-sans text-[11px] text-neutral-600 dark:text-neutral-400">{fmt(c.confirmedAt)}</span>,
            },
          }))}
        />
      )}
    </>
  );
}
