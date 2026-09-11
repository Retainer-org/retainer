import Link from "next/link";
import type { ReactNode } from "react";
import { Copy } from "@/components/dashboard/copy";

/* Small prose vocabulary for the docs. No MDX, no new dependencies -- the
   pages are TSX so every citation is a real link the type checker sees. */

export const H1 = ({ children, lede }: { children: ReactNode; lede?: ReactNode }) => (
  <header className="mb-10">
    <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-white">{children}</h1>
    {lede && <p className="mt-3 text-lg text-neutral-600 dark:text-neutral-400">{lede}</p>}
  </header>
);
export const H2 = ({ id, children }: { id?: string; children: ReactNode }) => (
  <h2 id={id} className="mt-12 mb-3 scroll-mt-28 text-xl font-semibold text-neutral-900 dark:text-white">{children}</h2>
);
export const H3 = ({ id, children }: { id?: string; children: ReactNode }) => (
  <h3 id={id} className="mt-8 mb-2 scroll-mt-28 text-base font-semibold text-neutral-900 dark:text-white">{children}</h3>
);
export const P = ({ children }: { children: ReactNode }) => (
  <p className="my-4 text-[15px] leading-7 text-neutral-700 dark:text-neutral-300">{children}</p>
);
export const UL = ({ children }: { children: ReactNode }) => (
  <ul className="my-4 list-disc space-y-2 pl-6 text-[15px] leading-7 text-neutral-700 dark:text-neutral-300">{children}</ul>
);
export const OL = ({ children }: { children: ReactNode }) => (
  <ol className="my-4 list-decimal space-y-2 pl-6 text-[15px] leading-7 text-neutral-700 dark:text-neutral-300">{children}</ol>
);
export const C = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[13px] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">{children}</code>
);
export const Pre = ({ children, title }: { children: string; title?: string }) => (
  <div className="my-5 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
    {title && <div className="border-b border-neutral-200 px-4 py-2 font-mono text-[11px] text-neutral-500 dark:border-white/10 dark:text-neutral-400">{title}</div>}
    <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-6 text-neutral-800 dark:text-neutral-200"><code>{children}</code></pre>
  </div>
);

/** A claim's source: file path (links to GitHub at main), contract, or tx. */
const REPO = "https://github.com/Retainer-org/retainer/blob/main/";
export const Cite = ({ file, line, tx, addr, label }: { file?: string; line?: number; tx?: string; addr?: string; label?: string }) => {
  const href = file ? `${REPO}${file}${line ? `#L${line}` : ""}` : tx ? `https://sepolia.basescan.org/tx/${tx}` : addr ? `https://sepolia.basescan.org/address/${addr}${addr === "0x337099eE403C090388A66cc9370F7b0Fe4CDcC79" ? "#code" : ""}` : "#";
  const text = label ?? (file ? `${file}${line ? `:${line}` : ""}` : tx ? `${tx.slice(0, 10)}…` : addr ? `${addr.slice(0, 10)}…` : "");
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer" className="ml-1 whitespace-nowrap rounded bg-brand-primary/10 px-1.5 py-0.5 align-baseline font-mono text-[11px] text-brand-primary hover:underline">
      {text}
    </Link>
  );
};

export const Addr = ({ value, tx }: { value: string; tx?: boolean }) => (
  <span className="inline-flex items-center font-mono text-[13px]">
    <Link href={tx ? `https://sepolia.basescan.org/tx/${value}` : `https://sepolia.basescan.org/address/${value}`} target="_blank" rel="noopener noreferrer" className="break-all text-brand-primary hover:underline">{value}</Link>
    <Copy value={value} />
  </span>
);

export const Callout = ({ kind = "note", title, children }: { kind?: "note" | "warn" | "limit"; title: string; children: ReactNode }) => {
  const ring = kind === "warn" ? "ring-amber-500/40" : kind === "limit" ? "ring-red-500/30" : "ring-neutral-300 dark:ring-white/15";
  return (
    <div className={`my-6 rounded-xl bg-white p-4 ring-1 dark:bg-neutral-900 ${ring}`}>
      <div className="text-sm font-semibold text-neutral-900 dark:text-white">{title}</div>
      <div className="mt-1 text-sm leading-6 text-neutral-700 dark:text-neutral-300">{children}</div>
    </div>
  );
};

export const Table = ({ head, rows }: { head: string[]; rows: ReactNode[][] }) => (
  <div className="my-5 overflow-x-auto rounded-xl border border-neutral-200 dark:border-white/10">
    <table className="w-full text-left text-sm">
      <thead className="bg-neutral-50 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
        <tr>{head.map((h) => <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-neutral-100 text-neutral-800 dark:divide-white/5 dark:text-neutral-200">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-3 py-2 align-top">{c}</td>)}</tr>)}
      </tbody>
    </table>
  </div>
);
