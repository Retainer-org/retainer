#!/usr/bin/env node
/**
 * Verify every citation in /docs still points at something real.
 *
 * Docs that link to code drift silently: a file gets renamed, a function moves
 * down a file, and the citation keeps rendering while quietly pointing at the
 * wrong line. This check resolves each one against the working tree and prints
 * the cited line so the claim can be read against its source.
 *
 * Filesystem only -- no dev server, no database, no network -- so it is safe to
 * run in CI or a pre-commit hook.
 *
 *   node scripts/check-doc-citations.mjs          # summary + failures
 *   node scripts/check-doc-citations.mjs --all    # print every citation
 *
 * Exit code 0 if every citation resolves, 1 otherwise.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "apps/web/app/docs");
const VERBOSE = process.argv.includes("--all");

const walk = (dir) =>
  readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
  });

/** Pull an attribute out of a JSX tag body, e.g. file="a/b.ts" or line={42}. */
const attr = (body, name) =>
  body.match(new RegExp(`${name}=(?:"([^"]*)"|\\{(\\d+)\\})`))?.slice(1).find(Boolean) ?? null;

const results = [];
let checked = 0;

for (const page of walk(DOCS).sort()) {
  const src = readFileSync(page, "utf8");
  const where = relative(ROOT, page);

  // <Cite file="..." line={n} /> — may span lines, attributes in any order.
  for (const m of src.matchAll(/<Cite\s+([^>]*?)\/>/gs)) {
    const body = m[1];
    const file = attr(body, "file");
    const line = attr(body, "line");
    if (!file) continue; // tx=/addr= citations are covered by the hex check below
    checked++;

    const target = join(ROOT, file);
    if (!existsSync(target)) {
      results.push({ ok: false, where, what: `${file}${line ? `:${line}` : ""}`, why: "file does not exist" });
      continue;
    }
    if (line) {
      const lines = readFileSync(target, "utf8").split("\n");
      if (Number(line) > lines.length) {
        results.push({ ok: false, where, what: `${file}:${line}`, why: `file has only ${lines.length} lines` });
        continue;
      }
      results.push({ ok: true, where, what: `${file}:${line}`, cited: lines[Number(line) - 1].trim().slice(0, 96) });
    } else {
      results.push({ ok: true, where, what: file, cited: "" });
    }
  }

  // Transaction hashes and addresses are links too: a typo yields a page that
  // loads and says nothing, which is worse than a broken link. Shape only --
  // this deliberately makes no network call.
  for (const [, raw] of src.matchAll(/<(?:Addr|Cite)\s+[^>]*?(?:value|tx|addr)="(0x[0-9a-fA-F]+)"/gs)) {
    checked++;
    const ok = raw.length === 66 || raw.length === 42;
    results.push({
      ok, where, what: `${raw.slice(0, 12)}…`,
      why: ok ? undefined : `expected 42 chars (address) or 66 (tx hash), got ${raw.length}`,
      cited: ok ? (raw.length === 66 ? "tx hash" : "address") : "",
    });
  }
}

const bad = results.filter((r) => !r.ok);
for (const r of results) {
  if (r.ok && !VERBOSE) continue;
  const tag = r.ok ? "ok  " : "FAIL";
  console.log(`  ${tag} ${r.what}${r.cited ? `  | ${r.cited}` : ""}${r.why ? `  <- ${r.why}  (${r.where})` : ""}`);
}

console.log(`\n  citations checked: ${checked} | problems: ${bad.length}`);
if (bad.length) {
  console.log("\n  A citation no longer resolves. Update the docs page, or the claim it supports.");
  process.exit(1);
}
console.log("  All docs citations resolve to real files and in-range lines.");
