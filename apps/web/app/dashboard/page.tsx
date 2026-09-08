import Link from "next/link";
import { Container } from "@/components/container";
import { Heading } from "@/components/heading";
import { Subheading } from "@/components/subheading";
import { loadSnapshot, type ChargeRow, type PermissionRow } from "@/lib/dashboard-data";

// Merchant-facing, read-only. Rendered on every request from the real database
// and the live chain -- never cached, never mocked. No actions: nothing here can
// charge, revoke or edit.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const usdc = (v: string | null | undefined) => (v == null ? "—" : (Number(v) / 1_000_000).toFixed(6));
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const ts = (unix: number) => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
const iso = (v: string | null) => (v ? v.replace("T", " ").slice(0, 16) + "Z" : "—");
const TX = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const ADDR = (a: string) => `https://sepolia.basescan.org/address/${a}`;

export default async function Dashboard() {
  const snap = await loadSnapshot();
  const failed = snap.charges.filter((c) => c.state.startsWith("failed"));
  const groups = {
    terminal: failed.filter((c) => c.state === "failed_terminal"),
    deferred: failed.filter((c) => c.state === "failed_deferred"),
    retrying: failed.filter((c) => c.state === "failed_retryable"),
  };

  return (
    <Container className="py-10 md:py-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Heading as="h1" className="text-3xl md:text-4xl">Dashboard</Heading>
          <Subheading className="mt-2">Did my customers pay? Read-only, from the real database and the live chain.</Subheading>
        </div>
        <div className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
          chain {snap.chainId} · head {snap.head} · rendered {iso(snap.fetchedAt)}
        </div>
      </div>

      {/* ------------------------------------------------------------ permissions */}
      <Section title="Permissions" sub="Current state is read from the SpendPermissionManager at render time; remaining allowance is this period's cap minus what the contract says has been spent.">
        {snap.permissions.length === 0 ? <Empty>No permissions in the database.</Empty> : (
          <Table head={["#", "Permission", "On-chain state", "Allowance / period", "Period", "Spent · remaining (this period)", "Window"]}>
            {snap.permissions.map((p) => <PermissionTr key={p.id} p={p} />)}
          </Table>
        )}
      </Section>

      {/* --------------------------------------------------------------- charges */}
      <Section title="Charges" sub="Requested is what the engine asked for; settled is what the on-chain SpendRouted event says moved. They must match.">
        {snap.charges.length === 0 ? <Empty>No charges in the database.</Empty> : (
          <Table head={["#", "Permission", "Amount", "Requested", "Settled on-chain", "State", "Transaction"]}>
            {snap.charges.map((c) => (
              <tr key={c.id} className="text-neutral-800 dark:text-neutral-200">
                <Td>#{c.id}</Td>
                <Td><span className="text-neutral-500 dark:text-neutral-400">{short(c.permissionHash)}</span></Td>
                <Td className="font-sans text-xs">
                  {c.amountSource === "usage"
                    ? <span className="rounded bg-brand-primary/10 px-1.5 py-0.5 text-brand-primary" title={c.usageNote ?? ""}>usage · computed at charge time</span>
                    : <span className="text-neutral-500 dark:text-neutral-400">fixed</span>}
                </Td>
                <Td className="text-right">{usdc(c.requested)}</Td>
                <Td className="text-right">{c.settled ? <>{usdc(c.settled)} {c.settled === c.requested ? <Ok>match</Ok> : <Bad>mismatch</Bad>}</> : <span className="text-neutral-400">—</span>}</Td>
                <Td><StatePill state={c.state} /></Td>
                <Td>{c.confirmedTx ? <Link href={TX(c.confirmedTx)} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{short(c.confirmedTx)}</Link> : <span className="text-neutral-400">none</span>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {/* -------------------------------------------------------- failed charges */}
      <Section title="Failed charges" sub="Every failure is classified from chain state before any gas is spent, and each class has its own disposition. This grouping is the product.">
        {failed.length === 0 ? <Empty>No failed charges.</Empty> : (
          <div className="grid gap-4 lg:grid-cols-3">
            <FailGroup title="Terminal — will not retry" note="Revoked or expired. The permission is gone; nothing the engine does can bring it back." rows={groups.terminal} tone="terminal" />
            <FailGroup title="Deferred — retries at a known time" note="Allowance exhausted, not yet started, or not yet registered. Retrying sooner is pure waste, so the engine waits for the instant it can succeed." rows={groups.deferred} tone="deferred" />
            <FailGroup title="Retrying — with backoff" note="Insufficient balance. A reverted charge consumes no allowance, so retrying is safe against the cap; it is capped by gas instead." rows={groups.retrying} tone="retrying" />
          </div>
        )}
      </Section>

      {/* -------------------------------------------------------- reconciliation */}
      <Section title="Reconciliation" sub="A charge is marked paid by the reconciler only — after both SpendPermissionUsed and SpendRouted are indexed for its transaction and the router paid the intended recipient. Never on broadcast, never on receipt alone.">
        <div className="mb-4 rounded-2xl bg-white p-4 font-mono text-xs shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
          {snap.indexer ? (
            <>indexer at block <b>{snap.indexer.lastIndexedBlock}</b> · chain head <b>{snap.head}</b> · <b>{snap.indexer.lag}</b> blocks behind · last advanced {iso(snap.indexer.updatedAt)}
              <div className="mt-1 font-sans text-neutral-500 dark:text-neutral-400">The indexer advances when the worker runs. A large lag means the worker is idle, not that money is missing — nothing is marked paid until it catches up.</div></>
          ) : <>indexer has not run yet</>}
        </div>
        {snap.charges.length === 0 ? <Empty>Nothing to reconcile.</Empty> : (
          <Table head={["#", "Broadcast attempts (state @ nonce)", "Mined", "Both events indexed", "Confirmed at", "Verdict"]}>
            {snap.charges.map((c) => <ReconTr key={c.id} c={c} />)}
          </Table>
        )}
      </Section>
    </Container>
  );
}

/* ------------------------------------------------------------------ rows */

function PermissionTr({ p }: { p: PermissionRow }) {
  return (
    <tr className="text-neutral-800 dark:text-neutral-200">
      <Td>#{p.id}</Td>
      <Td>
        <div>{short(p.hash)}</div>
        <div className="font-sans text-[11px] text-neutral-500 dark:text-neutral-400">
          from <Link href={ADDR(p.account)} target="_blank" rel="noopener noreferrer" className="hover:underline">{short(p.account)}</Link> → {short(p.recipient)}
        </div>
      </Td>
      <Td><OnchainPill state={p.onchain} /></Td>
      <Td>{usdc(p.allowance)} <span className="text-neutral-400">USDC</span></Td>
      <Td>{p.periodSeconds % 86400 === 0 ? `${p.periodSeconds / 86400}d` : `${p.periodSeconds / 3600}h`}</Td>
      <Td>{p.onchain === "active" && p.remainingThisPeriod != null
        ? <>{usdc(p.spentThisPeriod)} · <b>{usdc(p.remainingThisPeriod)}</b></>
        : <span className="text-neutral-400">—</span>}</Td>
      <Td className="font-sans text-[11px] text-neutral-500 dark:text-neutral-400">
        {ts(p.start)} → {ts(p.end)}
        {p.revokedAt && <div>revoked {iso(p.revokedAt)}</div>}
      </Td>
    </tr>
  );
}

function ReconTr({ c }: { c: ChargeRow }) {
  const mined = c.attemptSummary.some((a) => a.state === "mined_success");
  const verdict = c.state === "confirmed" ? "paid — reconciled on-chain"
    : mined ? "mined, awaiting reconciliation — NOT yet paid"
    : c.attemptSummary.length ? "broadcast, not mined — NOT paid"
    : "never broadcast";
  return (
    <tr className="text-neutral-800 dark:text-neutral-200">
      <Td>#{c.id}</Td>
      <Td className="font-sans text-xs">
        {c.attemptSummary.length === 0 ? <span className="text-neutral-400">none — failed pre-flight, no gas spent</span>
          : c.attemptSummary.map((a) => (
            <div key={a.tx} className="font-mono">
              <span className={a.state === "superseded" ? "line-through text-neutral-400" : ""}>{a.state}</span> @ {a.nonce}
              {a.state !== "superseded" && <> · <Link href={TX(a.tx)} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{short(a.tx)}</Link></>}
            </div>
          ))}
      </Td>
      <Td>{mined ? <Ok>yes</Ok> : <span className="text-neutral-400">no</span>}</Td>
      <Td>{c.confirmedTx ? (c.topicsIndexed >= 2 ? <Ok>2 / 2</Ok> : <Bad>{c.topicsIndexed} / 2</Bad>) : <span className="text-neutral-400">—</span>}</Td>
      <Td className="font-sans text-xs">{iso(c.confirmedAt)}</Td>
      <Td className="font-sans text-xs">{c.state === "confirmed" ? <Ok>{verdict}</Ok> : <span className="text-neutral-600 dark:text-neutral-300">{verdict}</span>}</Td>
    </tr>
  );
}

function FailGroup({ title, note, rows, tone }: { title: string; note: string; rows: ChargeRow[]; tone: "terminal" | "deferred" | "retrying" }) {
  const ring = tone === "terminal" ? "ring-red-500/30" : tone === "retrying" ? "ring-amber-500/30" : "ring-neutral-400/30";
  return (
    <div className={`rounded-2xl bg-white p-5 shadow-sm ring-1 dark:bg-neutral-900 ${ring}`}>
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">{title} <span className="ml-1 font-mono text-xs text-neutral-500 dark:text-neutral-400">{rows.length}</span></h3>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{note}</p>
      {rows.length === 0 ? <p className="mt-4 text-xs text-neutral-400">none</p> : (
        <ul className="mt-4 space-y-3">
          {rows.map((c) => (
            <li key={c.id} className="rounded-lg bg-neutral-50 p-3 font-mono text-xs dark:bg-neutral-800/60">
              <div className="flex items-center justify-between"><span>charge #{c.id}</span><span className="font-semibold">{c.lastFailure}</span></div>
              <div className="mt-1 text-neutral-600 dark:text-neutral-400">{c.failureDetail}</div>
              <div className="mt-1 text-neutral-500 dark:text-neutral-400">
                attempts {c.attempts}{tone !== "terminal" && c.nextAttemptAt && <> · next {iso(c.nextAttemptAt)}</>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ primitives */

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold text-neutral-900 dark:text-white">{title}</h2>
      <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">{sub}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
          <tr>{head.map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 font-mono text-[13px] dark:divide-white/5">{children}</tbody>
      </table>
    </div>
  );
}
function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) { return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>; }
function Empty({ children }: { children: React.ReactNode }) { return <p className="rounded-2xl bg-white p-6 text-sm text-neutral-500 ring-1 ring-black/10 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-white/10">{children}</p>; }
function Ok({ children }: { children: React.ReactNode }) { return <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-sans text-[11px] text-emerald-700 dark:text-emerald-400">{children}</span>; }
function Bad({ children }: { children: React.ReactNode }) { return <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-sans text-[11px] text-red-700 dark:text-red-400">{children}</span>; }
function StatePill({ state }: { state: string }) {
  const cls = state === "confirmed" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : state === "failed_terminal" ? "bg-red-500/10 text-red-700 dark:text-red-400"
    : state === "failed_retryable" ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : "bg-neutral-500/10 text-neutral-700 dark:text-neutral-300";
  return <span className={`rounded px-1.5 py-0.5 font-sans text-[11px] ${cls}`}>{state}</span>;
}
function OnchainPill({ state }: { state: PermissionRow["onchain"] }) {
  const label = { active: "active", revoked: "revoked", expired: "expired", not_started: "not yet started", not_registered: "signed, not registered" }[state];
  const cls = state === "active" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
    : state === "revoked" || state === "expired" ? "bg-red-500/10 text-red-700 dark:text-red-400"
    : "bg-neutral-500/10 text-neutral-700 dark:text-neutral-300";
  return <span className={`rounded px-1.5 py-0.5 font-sans text-[11px] ${cls}`}>{label}</span>;
}
