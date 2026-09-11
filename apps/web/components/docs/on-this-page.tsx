"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * "On this page", read from the rendered page: the headings that are actually there, so there
 * is nothing to keep in sync. The heading whose section is in view is highlighted as the
 * reader scrolls; clicking one scrolls to it and puts it in the address bar.
 */
type Item = { id: string; text: string; level: number };
const OFFSET = 112;   // just below the sticky header

export function useHeadings() {
  const path = usePathname();
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    const read = () => [...document.querySelectorAll<HTMLElement>("[data-doc] h2[id], [data-doc] h3[id]")];
    const hs = read();
    setItems(hs.map((h) => ({ id: h.id, text: h.textContent ?? "", level: h.tagName === "H3" ? 3 : 2 })));
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        let cur: string | null = hs[0]?.id ?? null;
        for (const h of hs) { if (h.getBoundingClientRect().top <= OFFSET + 8) cur = h.id; else break; }
        if (hs.length && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = hs[hs.length - 1].id;
        setActive(cur);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [path]);
  return { items, active, setActive };
}

export function jumpTo(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  history.replaceState(null, "", `#${id}`);
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function OnThisPage({ variant }: { variant: "rail" | "inline" }) {
  const { items, active, setActive } = useHeadings();
  if (items.length === 0) return null;
  const list = (
    <ul className="space-y-1 text-[13px]" data-on-this-page={variant}>
      {items.map((it) => (
        <li key={it.id}>
          <a href={`#${it.id}`} data-toc-id={it.id} aria-current={active === it.id ? "location" : undefined}
            onClick={(e) => { e.preventDefault(); setActive(it.id); jumpTo(it.id); }}
            className={`block border-l-2 py-1 leading-5 transition-colors ${it.level === 3 ? "pl-6" : "pl-3"} ${active === it.id
              ? "border-brand-primary font-medium text-brand-primary"
              : "border-transparent text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-white"}`}>
            {it.text}
          </a>
        </li>
      ))}
    </ul>
  );
  if (variant === "inline") return (
    <details className="group mb-8 rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 xl:hidden dark:border-white/10 dark:bg-neutral-900">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-neutral-800 dark:text-neutral-200">
        On this page
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4 transition-transform group-open:rotate-180" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div className="mt-3">{list}</div>
    </details>
  );
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-3.5" aria-hidden><path d="M4 6h16M4 12h10M4 18h13" /></svg>
        On this page
      </div>
      {list}
    </div>
  );
}
