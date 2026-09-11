"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import index from "@/lib/docs-index.json";

/**
 * Docs search. It searches what the pages actually say -- titles, headings and the prose
 * under each heading, extracted from the page components at build time -- and a result
 * lands on the heading it was found under, not just the page.
 */
type Rec = { href: string; page: string; id: string | null; heading: string; text: string; n: string; nh: string; nt: string; order: number };
const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

const RECORDS: Rec[] = (index as { pages: { href: string; title: string; lede: string; sections: { id: string | null; heading: string | null; text: string }[] }[] })
  .pages.flatMap((p, pi) => p.sections.map((s, si) => {
    const heading = s.heading ?? p.title;
    const text = s.id ? s.text : [p.lede, s.text].filter(Boolean).join(" ");
    return { href: p.href, page: p.title, id: s.id, heading, text, n: norm(text), nh: norm(heading), nt: norm(p.title), order: pi * 1000 + si };
  }));

type Hit = Rec & { score: number; at: number; len: number };

export function searchDocs(query: string): Hit[] {
  const q = norm(query);
  if (q.length < 2) return [];
  const terms = q.split(" ").filter((t) => t.length > 1);
  const hits: Hit[] = [];
  for (const r of RECORDS) {
    let score = 0, at = r.n.indexOf(q), len = q.length;
    if (!r.id && r.nt.includes(q)) score += 100;          // the page's own title
    if (r.nh.includes(q)) score += 60;                     // a heading
    if (at >= 0) score += 30;                              // the exact phrase in the prose
    else if (terms.length > 1 && terms.every((t) => r.n.includes(t) || r.nh.includes(t))) { score += 8; at = r.n.indexOf(terms[0]); len = terms[0].length; }
    if (score > 0) hits.push({ ...r, score, at, len });
  }
  return hits.sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 30);
}

function Snippet({ hit }: { hit: Hit }) {
  if (hit.at < 0) return <span className="line-clamp-2">{hit.text.slice(0, 160)}</span>;
  const start = Math.max(0, hit.at - 70);
  const pre = (start > 0 ? "…" : "") + hit.text.slice(start, hit.at);
  const mid = hit.text.slice(hit.at, hit.at + hit.len);
  const post = hit.text.slice(hit.at + hit.len, hit.at + hit.len + 110) + (hit.at + hit.len + 110 < hit.text.length ? "…" : "");
  return <span>{pre}<mark className="rounded bg-brand-primary/15 px-0.5 text-inherit dark:bg-brand-primary/30">{mid}</mark>{post}</span>;
}

export function DocsSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const path = usePathname();
  const hits = useMemo(() => searchDocs(q), [q]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === "/" && !typing) { e.preventDefault(); setOpen(true); }
      else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Reopening keeps the last query in view, selected, so typing replaces it rather than adding to it.
  useEffect(() => { if (open) { setSel(0); setTimeout(() => { input.current?.focus(); input.current?.select(); }, 0); } }, [open]);
  useEffect(() => setSel(0), [q]);

  function go(h: Hit) {
    setOpen(false);
    const url = h.href + (h.id ? `#${h.id}` : "");
    if (h.href === path) {
      if (h.id) { history.replaceState(null, "", `#${h.id}`); document.getElementById(h.id)?.scrollIntoView({ block: "start" }); }
      else window.scrollTo({ top: 0 });
    } else router.push(url);
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} data-docs-search-open
        className="flex h-10 w-full items-center gap-2.5 rounded-xl border border-neutral-200 bg-neutral-50 px-3 text-left text-sm text-neutral-500 transition-colors hover:border-neutral-300 hover:bg-white dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:border-white/20 dark:hover:bg-neutral-800">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4 shrink-0" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="flex-1 truncate">Search the docs…</span>
        <kbd className="hidden rounded-md border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 sm:block dark:border-white/10 dark:bg-neutral-800 dark:text-neutral-400">⌘K</kbd>
      </button>

      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center bg-neutral-950/40 px-3 pt-[10vh] backdrop-blur-sm" onMouseDown={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Search the docs">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10" onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-neutral-200 px-4 dark:border-white/10">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-5 shrink-0 text-neutral-400" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} data-docs-search-input placeholder="Search titles, headings and text…" aria-label="Search the docs"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, hits.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
                  else if (e.key === "Enter" && hits[sel]) { e.preventDefault(); go(hits[sel]); }
                }}
                className="h-14 flex-1 bg-transparent text-base text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-white" />
              <kbd className="rounded-md border border-neutral-200 px-1.5 py-0.5 font-mono text-[11px] text-neutral-500 dark:border-white/10">Esc</kbd>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto p-2" data-docs-search-results>
              {q.trim().length >= 2 && hits.length === 0 && (
                <li className="px-3 py-8 text-center text-sm text-neutral-500" data-docs-search-empty>No results for &ldquo;{q.trim()}&rdquo;.</li>
              )}
              {q.trim().length < 2 && <li className="px-3 py-6 text-center text-sm text-neutral-500">Type to search every page — titles, headings and text.</li>}
              {hits.map((h, i) => (
                <li key={`${h.href}#${h.id}`}>
                  <button type="button" onMouseEnter={() => setSel(i)} onClick={() => go(h)} data-result data-result-href={h.href} data-result-id={h.id ?? ""}
                    className={`block w-full rounded-xl px-3 py-2.5 text-left ${i === sel ? "bg-brand-primary/10" : ""}`}>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">{h.page}{h.id && <> <span className="px-1">›</span> </>}{h.id && <span className="font-medium text-neutral-700 dark:text-neutral-200">{h.heading}</span>}</div>
                    <div className="mt-1 text-sm leading-6 text-neutral-700 dark:text-neutral-300"><Snippet hit={h} /></div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-4 border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-500 dark:border-white/10">
              <span><kbd className="font-mono">↑↓</kbd> to move</span><span><kbd className="font-mono">↵</kbd> to open</span><span className="ml-auto">{hits.length ? `${hits.length} result${hits.length > 1 ? "s" : ""}` : ""}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
