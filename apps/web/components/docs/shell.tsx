"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ModeToggle } from "@/components/mode-toggle";
import nav from "@/lib/docs-nav.json";
import index from "@/lib/docs-index.json";
import { DocsSearch } from "./search";
import { OnThisPage, useHeadings, jumpTo } from "./on-this-page";

/**
 * The docs as a documentation site, not a page inside the app: its own header with search,
 * a sidebar of sections and the pages in them (the open page's headings nested beneath it),
 * the page itself, and "on this page" on the right. Sections and pages come from
 * lib/docs-nav.json; headings come from the pages -- nothing here names a topic.
 */
type Page = { href: string; title: string; file: string };
const sections = (nav as { sections: { title: string; pages: Page[] }[] }).sections;
const order = sections.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));
const headingsOf = Object.fromEntries((index as { pages: { href: string; sections: { id: string | null; level: number; heading: string | null }[] }[] })
  .pages.map((p) => [p.href, p.sections.filter((s) => s.id && s.level === 2) as { id: string; heading: string }[]]));

function Sidebar({ path, onNavigate }: { path: string; onNavigate?: () => void }) {
  const { active } = useHeadings();
  return (
    <nav aria-label="Documentation" className="space-y-7">
      {sections.map((s) => (
        <div key={s.title} data-docs-section={s.title}>
          <div className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">{s.title}</div>
          <ul className="space-y-0.5">
            {s.pages.map((p) => {
              const on = path === p.href;
              return (
                <li key={p.href}>
                  <Link href={p.href} onClick={onNavigate} aria-current={on ? "page" : undefined} data-docs-page={p.href}
                    className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${on
                      ? "bg-brand-primary/10 font-medium text-brand-primary"
                      : "text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-white/5 dark:hover:text-white"}`}>
                    {p.title}
                  </Link>
                  {on && headingsOf[p.href]?.length > 0 && (
                    <ul className="my-1 ml-4 space-y-0.5 border-l border-neutral-200 pl-2 dark:border-white/10" data-docs-subnav>
                      {headingsOf[p.href].map((h) => (
                        <li key={h.id}>
                          <a href={`#${h.id}`} onClick={(e) => { e.preventDefault(); onNavigate?.(); jumpTo(h.id); }}
                            className={`block rounded-md px-2 py-1 text-[13px] leading-5 transition-colors ${active === h.id
                              ? "text-brand-primary" : "text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white"}`}>
                            {h.heading}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="px-3 text-[11px] leading-5 text-neutral-500 dark:text-neutral-400">
        Every claim on these pages points at a file in the repository, a verified contract, or a transaction on Base Sepolia. Where something is unknown, it says so.
      </p>
    </nav>
  );
}

export function DocsShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const i = order.findIndex((p) => p.href === path);
  const prev = i > 0 ? order[i - 1] : null;
  const next = i >= 0 && i < order.length - 1 ? order[i + 1] : null;
  const here = i >= 0 ? order[i] : null;

  useEffect(() => setOpen(false), [path]);
  // Land on the heading in the address (from search, or a shared link), once the page is rendered.
  useEffect(() => {
    const go = () => {
      const id = decodeURIComponent(location.hash.slice(1));
      if (!id) return;
      let n = 0;
      const t = setInterval(() => { const el = document.getElementById(id); if (el || ++n > 40) { clearInterval(t); el?.scrollIntoView({ block: "start" }); } }, 50);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, [path]);

  return (
    <div className="min-h-screen bg-white dark:bg-neutral-950">
      <header className="sticky top-0 z-40 border-b border-neutral-200 bg-white/85 backdrop-blur-md dark:border-white/10 dark:bg-neutral-950/85">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 md:px-6">
          <button onClick={() => setOpen(true)} className="flex size-9 items-center justify-center rounded-lg text-neutral-800 hover:bg-neutral-100 lg:hidden dark:text-neutral-200 dark:hover:bg-white/5" aria-label="Open the table of contents" data-docs-menu>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-5"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="size-4 text-brand-primary" aria-hidden><path d="M4 12h16" /><path d="M14 6l6 6-6 6" /></svg>
            <span className="font-semibold text-neutral-900 dark:text-white">Retainer</span>
          </Link>
          <Link href="/docs" className="hidden shrink-0 rounded-md px-1.5 text-sm font-medium text-neutral-500 hover:text-neutral-900 sm:block dark:text-neutral-400 dark:hover:text-white">Docs</Link>
          <div className="mx-auto w-full max-w-md px-1 md:px-4"><DocsSearch /></div>
          <div className="flex shrink-0 items-center gap-4">
            <Link href="/dashboard" className="hidden text-sm text-neutral-600 hover:text-neutral-900 md:block dark:text-neutral-400 dark:hover:text-white">Dashboard</Link>
            <Link href="https://github.com/Retainer-org/retainer" target="_blank" rel="noopener noreferrer" className="hidden text-sm text-neutral-600 hover:text-neutral-900 md:block dark:text-neutral-400 dark:hover:text-white">Source</Link>
            <ModeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1440px] lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_15rem]">
        <aside className="hidden lg:block">
          <div className="sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto border-r border-neutral-200 px-3 py-6 dark:border-white/10">
            <Sidebar path={path} />
          </div>
        </aside>

        <main className="min-w-0 px-4 py-8 md:px-10 md:py-12">
          <div className="mx-auto max-w-3xl">
            {here && (
              <div className="mb-3 text-xs font-medium uppercase tracking-wider text-brand-primary">{here.section}</div>
            )}
            <OnThisPage variant="inline" />
            <article data-doc>{children}</article>
            <nav className="mt-16 grid gap-3 border-t border-neutral-200 pt-8 sm:grid-cols-2 dark:border-white/10" aria-label="Previous and next">
              {prev ? (
                <Link href={prev.href} className="group rounded-xl border border-neutral-200 p-4 transition-colors hover:border-brand-primary/50 dark:border-white/10">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">← Previous</div>
                  <div className="mt-1 text-sm font-medium text-neutral-900 group-hover:text-brand-primary dark:text-white">{prev.title}</div>
                </Link>
              ) : <span className="hidden sm:block" />}
              {next && (
                <Link href={next.href} className="group rounded-xl border border-neutral-200 p-4 text-right transition-colors hover:border-brand-primary/50 dark:border-white/10">
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">Next →</div>
                  <div className="mt-1 text-sm font-medium text-neutral-900 group-hover:text-brand-primary dark:text-white">{next.title}</div>
                </Link>
              )}
            </nav>
          </div>
        </main>

        <aside className="hidden xl:block">
          <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-6 py-12">
            <OnThisPage variant="rail" />
          </div>
        </aside>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Table of contents">
          <div className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[85%] max-w-sm overflow-y-auto bg-white px-3 py-5 shadow-2xl dark:bg-neutral-950" data-docs-drawer>
            <div className="mb-5 flex items-center justify-between px-3">
              <span className="text-sm font-semibold text-neutral-900 dark:text-white">Documentation</span>
              <button onClick={() => setOpen(false)} className="flex size-8 items-center justify-center rounded-lg text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/5" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-5"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
            <Sidebar path={path} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
