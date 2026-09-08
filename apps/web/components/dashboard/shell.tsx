"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import type { Context } from "@/lib/dashboard-data";

const nav = [
  { href: "/dashboard/permissions", label: "Permissions" },
  { href: "/dashboard/charges", label: "Charges" },
  { href: "/dashboard/failures", label: "Failures" },
  { href: "/dashboard/reconciliation", label: "Reconciliation" },
];

const fmt = (v: string) => new Date(v).toISOString().slice(0, 19) + "Z";

/**
 * Application shell: sticky top bar, left sidebar, main region. No marketing
 * footer. The top bar is sticky in normal flow, so content never scrolls
 * underneath it.
 */
export function Shell({ ctx, children }: { ctx: Context; children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  const links = nav.map((n) => {
    const active = path === n.href || path.startsWith(n.href + "/");
    return (
      <Link key={n.href} href={n.href} onClick={() => setOpen(false)}
        className={`block rounded-lg px-3 py-2 text-sm transition-colors ${active
          ? "bg-neutral-900 font-medium text-white dark:bg-white dark:text-black"
          : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"}`}>
        {n.label}
      </Link>
    );
  });

  return (
    <div className="flex min-h-screen flex-col bg-neutral-50 dark:bg-neutral-950">
      <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-white/10 dark:bg-neutral-900/90">
        <div className="flex h-14 items-center gap-3 px-4 md:px-6">
          <button onClick={() => setOpen(!open)} className="flex size-9 items-center justify-center rounded-md md:hidden" aria-label="Toggle navigation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-5 text-neutral-900 dark:text-white"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <Link href="/" className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-4 text-brand-primary" aria-hidden><path d="M4 12h16" /><path d="M14 6l6 6-6 6" /></svg>
            <span className="font-semibold text-black dark:text-white">Retainer</span>
          </Link>
          <span className="text-neutral-300 dark:text-neutral-700">/</span>
          <span className="text-sm text-neutral-700 dark:text-neutral-300">Dashboard</span>
          <span className="ml-1 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium tracking-wide text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">READ-ONLY</span>

          {/* context strip: which chain, how fresh, how far behind */}
          <div className="ml-auto hidden font-mono text-[11px] text-neutral-500 lg:block dark:text-neutral-400">
            chain {ctx.chainId} · head {ctx.head}
            {ctx.indexer && <> · indexed {ctx.indexer.lastIndexedBlock} ({ctx.indexer.lag} behind)</>}
            {" "}· rendered {fmt(ctx.fetchedAt)}
          </div>
          <div className="ml-auto lg:ml-3"><ModeToggle /></div>
        </div>
        {/* the same strip, wrapped, on narrow screens */}
        <div className="border-t border-neutral-100 px-4 py-1.5 font-mono text-[11px] text-neutral-500 lg:hidden dark:border-white/5 dark:text-neutral-400">
          chain {ctx.chainId} · head {ctx.head}{ctx.indexer && <> · {ctx.indexer.lag} behind</>} · {fmt(ctx.fetchedAt)}
        </div>
      </header>

      <div className="flex flex-1">
        <aside className={`${open ? "block" : "hidden"} w-full shrink-0 border-b border-neutral-200 bg-white p-3 md:block md:w-56 md:border-r md:border-b-0 dark:border-white/10 dark:bg-neutral-900`}>
          <nav className="space-y-1">{links}</nav>
          <p className="mt-6 px-3 text-[11px] leading-5 text-neutral-500 dark:text-neutral-400">
            Every row is read from the database and the chain when the page renders. Nothing is cached, and nothing here can charge, revoke or edit.
          </p>
        </aside>
        <main className={`${open ? "hidden md:block" : "block"} min-w-0 flex-1 p-4 md:p-6`}>{children}</main>
      </div>
    </div>
  );
}
