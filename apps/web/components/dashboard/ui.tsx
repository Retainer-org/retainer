import Link from "next/link";
import type { ReactNode } from "react";
import { Copy } from "./copy";
import type { OnchainState } from "@/lib/dashboard-data";

/* ---------------------------------------------------------------- format */

/** One timestamp format everywhere: full ISO-8601 UTC, to the second. */
export const fmt = (v: string | null | undefined) => (v ? new Date(v).toISOString().slice(0, 19) + "Z" : "—");
export const fmtUnix = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 19) + "Z";
export const usdc = (v: string | null | undefined) => (v == null ? "—" : (Number(v) / 1_000_000).toFixed(6));
export const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
export const period = (s: number) => (s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${s}s`);

const TX = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const ADDR = (a: string) => `https://sepolia.basescan.org/address/${a}`;

/** Truncated hash/address with a copy control and, where it makes sense, a Basescan link. */
export function Hash({ value, kind, struck }: { value: string; kind?: "tx" | "address"; struck?: boolean }) {
  const text = <span className={struck ? "text-neutral-400 line-through" : ""}>{short(value)}</span>;
  return (
    <span className="inline-flex items-center whitespace-nowrap font-mono">
      {kind && !struck
        ? <Link href={kind === "tx" ? TX(value) : ADDR(value)} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{text}</Link>
        : text}
      <Copy value={value} />
    </span>
  );
}

/* ----------------------------------------------------------------- pills */

const tone = {
  good: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  bad: "bg-red-500/10 text-red-700 dark:text-red-400",
  warn: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  muted: "bg-neutral-500/10 text-neutral-700 dark:text-neutral-300",
  brand: "bg-brand-primary/10 text-brand-primary",
} as const;

export function Pill({ t, children, title }: { t: keyof typeof tone; children: ReactNode; title?: string }) {
  return <span title={title} className={`inline-block rounded px-1.5 py-0.5 font-sans text-[11px] whitespace-nowrap ${tone[t]}`}>{children}</span>;
}
export function StatePill({ state }: { state: string }) {
  const t = state === "confirmed" ? "good" : state === "failed_terminal" ? "bad" : state === "failed_retryable" ? "warn" : "muted";
  return <Pill t={t}>{state}</Pill>;
}
export function OnchainPill({ state }: { state: OnchainState }) {
  const label = { active: "active", revoked: "revoked", expired: "expired", not_started: "not yet started", not_registered: "signed, not registered", unknown: "unknown — RPC unreachable" }[state];
  const t = state === "active" ? "good" : state === "revoked" || state === "expired" ? "bad" : state === "unknown" ? "warn" : "muted";
  return <Pill t={t} title={state === "unknown" ? "The chain could not be read on this render. Nothing is inferred from the absence of a reading." : undefined}>{label}</Pill>;
}

/* --------------------------------------------------------------- layout */

export function PageHeader({ title, sub, aside }: { title: string; sub: string; aside?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-neutral-900 dark:text-white">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-neutral-600 dark:text-neutral-400">{sub}</p>
      </div>
      {aside}
    </div>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl bg-white p-6 text-sm text-neutral-500 ring-1 ring-black/10 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-white/10">{children}</p>;
}
export function Note({ children }: { children: ReactNode }) {
  return <div className="mb-4 rounded-2xl bg-white p-4 text-xs text-neutral-600 shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-white/10">{children}</div>;
}

/* ----------------------------------------------------------- data table */

export type Column = { key: string; label: string; align?: "right"; className?: string };
export type TableRow = { key: string; cells: Record<string, ReactNode>; muted?: boolean };

/**
 * One row definition, two renderings. On md+ a real table with the first
 * column pinned so hashes survive horizontal scroll; below md, stacked cards
 * with label/value pairs, so seven columns of hex stay readable on a phone.
 */
export function DataTable({ columns, rows }: { columns: Column[]; rows: TableRow[] }) {
  const first = columns[0];
  return (
    <>
      <div className="hidden overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-black/10 md:block dark:bg-neutral-900 dark:ring-white/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            <tr>
              {columns.map((c, i) => (
                <th key={c.key} className={`px-4 py-3 font-medium whitespace-nowrap ${c.align === "right" ? "text-right" : ""} ${i === 0 ? "sticky left-0 z-10 bg-white dark:bg-neutral-900" : ""}`}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 font-mono text-[13px] text-neutral-800 dark:divide-white/5 dark:text-neutral-200">
            {rows.map((r) => (
              <tr key={r.key} className={r.muted ? "text-neutral-500 dark:text-neutral-400" : ""}>
                {columns.map((c, i) => (
                  <td key={c.key} className={`px-4 py-3 align-top ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""} ${i === 0 ? "sticky left-0 z-10 bg-white dark:bg-neutral-900" : ""}`}>{r.cells[c.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {rows.map((r) => (
          <li key={r.key} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
            <div className="mb-2 font-mono text-sm font-semibold text-neutral-900 dark:text-white">{r.cells[first.key]}</div>
            <dl className="space-y-1.5">
              {columns.slice(1).map((c) => (
                <div key={c.key} className="grid grid-cols-[7.5rem_1fr] gap-2 text-[13px]">
                  <dt className="text-xs text-neutral-500 dark:text-neutral-400">{c.label}</dt>
                  <dd className="min-w-0 font-mono break-words text-neutral-800 dark:text-neutral-200">{r.cells[c.key]}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}
