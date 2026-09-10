"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";

// Reading surface, not a scroll: sticky top bar, a sidebar of topics, a prose
// column. Modelled on the dashboard shell rather than the marketing pages.
export const topics = [
  { href: "/docs", label: "What Retainer is" },
  { href: "/docs/spend-permissions", label: "Spend permissions" },
  { href: "/docs/wallets", label: "Signing with any wallet" },
  { href: "/docs/charge-lifecycle", label: "The charge lifecycle" },
  { href: "/docs/failure-modes", label: "The six failure modes" },
  { href: "/docs/exactly-once", label: "Exactly-once charging" },
  { href: "/docs/expected-payments", label: "Expected payments" },
  { href: "/docs/watch-mode", label: "Watch mode" },
  { href: "/docs/matching", label: "The matching engine" },
  { href: "/docs/review-queue", label: "The review queue" },
  { href: "/docs/alerts", label: "Overdue detection and alerts" },
  { href: "/docs/custody", label: "Custody model" },
  { href: "/docs/contracts", label: "Contracts and addresses" },
  { href: "/docs/limitations", label: "Current limitations" },
];

export function DocsShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const idx = topics.findIndex((t) => t.href === path);
  const prev = idx > 0 ? topics[idx - 1] : null;
  const next = idx >= 0 && idx < topics.length - 1 ? topics[idx + 1] : null;

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-neutral-950">
      <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white/90 backdrop-blur dark:border-white/10 dark:bg-neutral-900/90">
        <div className="flex h-14 items-center gap-3 px-4 md:px-6">
          <button onClick={() => setOpen(!open)} className="flex size-9 items-center justify-center rounded-md md:hidden" aria-label="Toggle topics">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-5 text-neutral-900 dark:text-white"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <Link href="/" className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-4 text-brand-primary" aria-hidden><path d="M4 12h16" /><path d="M14 6l6 6-6 6" /></svg>
            <span className="font-semibold text-black dark:text-white">Retainer</span>
          </Link>
          <span className="text-neutral-300 dark:text-neutral-700">/</span>
          <span className="text-sm text-neutral-700 dark:text-neutral-300">Docs</span>
          <span className="ml-1 rounded-full border border-neutral-300 px-2 py-0.5 text-[10px] font-medium tracking-wide text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">BASE SEPOLIA</span>
          <div className="ml-auto flex items-center gap-4">
            <Link href="/dashboard" className="hidden text-sm text-neutral-600 hover:text-neutral-900 md:block dark:text-neutral-400 dark:hover:text-white">Dashboard</Link>
            <Link href="https://github.com/Retainer-org/retainer" target="_blank" rel="noopener noreferrer" className="hidden text-sm text-neutral-600 hover:text-neutral-900 md:block dark:text-neutral-400 dark:hover:text-white">Source</Link>
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className={`${open ? "block" : "hidden"} w-full shrink-0 border-b border-neutral-200 bg-white p-3 md:sticky md:top-14 md:block md:h-[calc(100vh-3.5rem)] md:w-64 md:overflow-y-auto md:border-r md:border-b-0 dark:border-white/10 dark:bg-neutral-950`}>
          <nav className="space-y-0.5">
            {topics.map((t, i) => {
              const active = path === t.href;
              return (
                <Link key={t.href} href={t.href} onClick={() => setOpen(false)}
                  className={`flex items-baseline gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${active
                    ? "bg-neutral-900 font-medium text-white dark:bg-white dark:text-black"
                    : "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"}`}>
                  <span className={`font-mono text-[11px] ${active ? "opacity-70" : "text-neutral-400"}`}>{String(i + 1).padStart(2, "0")}</span>
                  {t.label}
                </Link>
              );
            })}
          </nav>
          <p className="mt-6 px-3 text-[11px] leading-5 text-neutral-500 dark:text-neutral-400">
            Every claim on these pages points at a file in the repository, a verified contract, or a transaction on Base Sepolia. Where something is unknown, it says so.
          </p>
        </aside>

        <main className={`${open ? "hidden md:block" : "block"} min-w-0 flex-1`}>
          <div className="mx-auto max-w-3xl px-4 py-8 md:px-10 md:py-12">
            {children}
            <div className="mt-16 flex items-center justify-between border-t border-neutral-200 pt-6 text-sm dark:border-white/10">
              {prev ? <Link href={prev.href} className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white">← {prev.label}</Link> : <span />}
              {next ? <Link href={next.href} className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white">{next.label} →</Link> : <span />}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
