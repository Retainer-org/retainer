import { loadSnapshot } from "@/lib/dashboard-data";
import { DataTable, Empty, Hash, OnchainPill, PageHeader, fmt, fmtUnix, period, usdc } from "@/components/dashboard/ui";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Permissions() {
  const { permissions } = await loadSnapshot();
  const active = permissions.filter((p) => p.onchain === "active").length;
  return (
    <>
      <PageHeader title="Permissions" reads="db+chain" sub="On-chain state is read from the SpendPermissionManager at render time. Remaining is this period's cap minus what the contract says has been spent. Ordered by most recent activity; inactive test permissions sit at the bottom."
        aside={<span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">{permissions.length} total · {active} active</span>} />
      {permissions.length === 0 ? <Empty>No permissions in the database.</Empty> : (
        <DataTable
          columns={[
            { key: "id", label: "#" }, { key: "hash", label: "Permission" }, { key: "state", label: "On-chain state" },
            { key: "allow", label: "Allowance / period" }, { key: "spend", label: "Spent · remaining" },
            { key: "parties", label: "Account → recipient" }, { key: "window", label: "Window (UTC)" }, { key: "activity", label: "Last activity" },
          ]}
          rows={permissions.map((p) => ({
            key: p.id, muted: p.onchain !== "active",
            cells: {
              id: <>#{p.id}</>,
              hash: <Hash value={p.hash} />,
              state: <>
                <OnchainPill state={p.onchain} />
                {p.revokedAt && <div className="mt-1 font-sans text-[11px] text-neutral-500 dark:text-neutral-400">revoked {fmt(p.revokedAt)}</div>}
              </>,
              allow: <>{usdc(p.allowance)} <span className="text-neutral-400">USDC</span> / {period(p.periodSeconds)}</>,
              spend: p.onchain === "active" && p.remainingThisPeriod != null
                ? <>{usdc(p.spentThisPeriod)} · <b>{usdc(p.remainingThisPeriod)}</b></>
                : <span className="text-neutral-400">—</span>,
              parties: <div className="flex flex-col gap-0.5"><Hash value={p.account} kind="address" /><span className="text-neutral-400">→ <Hash value={p.recipient} kind="address" /></span></div>,
              window: <div className="font-sans text-[11px] leading-5 text-neutral-600 dark:text-neutral-400">{fmtUnix(p.start)}<br />{fmtUnix(p.end)}</div>,
              activity: <span className="font-sans text-[11px] text-neutral-600 dark:text-neutral-400">{fmt(p.lastActivity)}<br />{p.chargeCount} charge{p.chargeCount === 1 ? "" : "s"}</span>,
            },
          }))}
        />
      )}
    </>
  );
}
