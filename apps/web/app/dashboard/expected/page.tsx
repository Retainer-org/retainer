import Link from "next/link";
import { loadExpectedPayments } from "@/lib/dashboard-data";
import { DataTable, Empty, Hash, PageHeader, Pill, fmt, usdc } from "@/components/dashboard/ui";

// Expected payments are the top-level obligation. A charge is one way to
// satisfy one; a matched incoming transfer is the other.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATE_TONE = {
  overdue: "bad", due: "warn", partially_paid: "warn",
  upcoming: "muted", paid: "good", void: "muted",
} as const;

export default async function Expected() {
  const all = await loadExpectedPayments();
  const count = (s: string) => all.filter((e) => e.state === s).length;
  const outstanding = all
    .filter((e) => ["due", "overdue", "partially_paid"].includes(e.state))
    .reduce((t, e) => t + BigInt(e.outstanding), BigInt(0));

  return (
    <>
      <PageHeader
        title="Expected payments" reads="db"
        sub="What is owed, when it is due, and whether it arrived. Satisfied either by a pull against a spend permission or by a matched incoming transfer — both first-class, so a failed pull and a payment that never arrived both end up overdue here."
        aside={<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{all.length} total</span>}
      />

      {/*
        The four states a merchant acts on are always shown, at zero if that is
        the truth. Partially paid and void get a tile only when they exist, so
        the tiles always add up to the total in the header rather than quietly
        omitting rows the table still lists.
      */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Overdue" value={count("overdue")} tone="bad" />
        <Stat label="Due" value={count("due")} tone="warn" />
        {count("partially_paid") > 0 && <Stat label="Partially paid" value={count("partially_paid")} tone="warn" />}
        <Stat label="Upcoming" value={count("upcoming")} tone="muted" />
        <Stat label="Paid" value={count("paid")} tone="good" />
        {count("void") > 0 && <Stat label="Void" value={count("void")} tone="muted" />}
      </div>
      <p className="mb-6 font-mono text-xs text-neutral-600 dark:text-neutral-400">
        outstanding across everything not yet settled: <b>{usdc(outstanding.toString())} USDC</b>
      </p>

      {all.length === 0 ? (
        <Empty>No expected payments yet.</Empty>
      ) : (
        <DataTable
          columns={[
            { key: "id", label: "#" }, { key: "customer", label: "Customer" }, { key: "state", label: "State" },
            { key: "expected", label: "Expected", align: "right" }, { key: "settled", label: "Settled", align: "right" },
            { key: "outstanding", label: "Outstanding", align: "right" },
            { key: "how", label: "Fulfilment" }, { key: "due", label: "Due (UTC)" }, { key: "evidence", label: "Evidence" },
          ]}
          rows={all.map((e) => ({
            key: e.id,
            muted: e.state === "void" || e.state === "paid",
            cells: {
              id: <>#{e.id}</>,
              customer: <span className="font-sans text-xs">{e.customerLabel}</span>,
              state: <Pill t={STATE_TONE[e.state as keyof typeof STATE_TONE] ?? "muted"}>{e.state}</Pill>,
              expected: usdc(e.amountExpected),
              settled: usdc(e.amountSettled),
              outstanding: BigInt(e.outstanding) > BigInt(0)
                ? <b>{usdc(e.outstanding)}</b>
                : <span className="text-neutral-400">0.000000</span>,
              how: e.fulfilment === "pull"
                ? <Pill t="muted" title={e.chargeState ? `charge ${e.chargeId} is ${e.chargeState}` : undefined}>pull{e.chargeState ? ` · ${e.chargeState}` : ""}</Pill>
                : <Pill t="brand">watch</Pill>,
              due: <span className="font-sans text-[11px] text-neutral-600 dark:text-neutral-400">{fmt(e.dueDate)}</span>,
              evidence: e.chargeTx
                ? <Hash value={e.chargeTx} kind="tx" />
                : e.matchCount > 0
                  ? <span className="font-sans text-[11px]">{e.matchCount} matched transfer{e.matchCount === 1 ? "" : "s"}</span>
                  : <span className="text-neutral-400">—</span>,
            },
          }))}
        />
      )}
      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Nothing is settled here without on-chain confirmation: either a charge the reconciler confirmed from its events, or a
        transfer matched at three confirmations. Ambiguous transfers wait in the <Link href="/dashboard/review" className="text-brand-primary hover:underline">review queue</Link>.
      </p>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "bad" | "warn" | "muted" | "good" }) {
  const ring = { bad: "ring-red-500/30", warn: "ring-amber-500/30", muted: "ring-neutral-400/25", good: "ring-emerald-500/30" }[tone];
  return (
    <div className={`rounded-2xl bg-white p-4 shadow-sm ring-1 dark:bg-neutral-900 ${ring}`}>
      <div className="font-mono text-2xl font-semibold text-neutral-900 dark:text-white">{value}</div>
      <div className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{label}</div>
    </div>
  );
}
