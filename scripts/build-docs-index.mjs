#!/usr/bin/env node
/**
 * Build the docs search index from the page components themselves.
 *
 * The docs stay TSX -- every citation is a real component the type checker and
 * check:docs see -- so nothing is migrated and no cited line moves. This reads each
 * page listed in apps/web/lib/docs-nav.json through the TypeScript compiler (not by
 * pattern-matching), and records its title, lede, and every heading with the prose
 * beneath it, into apps/web/lib/docs-index.json. Search reads that file.
 *
 *   node scripts/build-docs-index.mjs           write the index
 *   node scripts/build-docs-index.mjs --check   fail if the index is stale, a heading has
 *                                               no id, or a docs page is not in the manifest
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(join(ROOT, 'apps/web/package.json'))('typescript');
const NAV = join(ROOT, 'apps/web/lib/docs-nav.json');
const OUT = join(ROOT, 'apps/web/lib/docs-index.json');
const CHECK = process.argv.includes('--check');

// Components whose content is not reading text: citation chips (file paths, hashes) and raw addresses.
const SKIP = new Set(['Cite', 'Addr', 'Architecture']);
// Attributes that carry reading text; every other attribute (className, href, file, id...) is ignored.
const TEXT_ATTRS = new Set(['title', 'lede', 'head', 'rows']);

const ENTITIES = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←', times: '×', middot: '·' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m);
const tidy = (s) => s.replace(/\s+/g, ' ').replace(/\s+([.,;:!?)])/g, '$1').trim();

function extract(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const page = { title: null, lede: '', sections: [] };
  const problems = [];
  let cur = { id: null, level: 1, heading: null, parts: [] };
  page.sections.push(cur);

  const tagOf = (n) => (ts.isJsxElement(n) ? n.openingElement : n).tagName.getText(sf);
  const attrsOf = (n) => (ts.isJsxElement(n) ? n.openingElement : n).attributes.properties;
  const attr = (n, name) => attrsOf(n).find((a) => ts.isJsxAttribute(a) && a.name.getText(sf) === name);
  const strAttr = (n, name) => { const a = attr(n, name); return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : null; };

  /** All reading text beneath a node, in document order. */
  function text(node) {
    const out = [];
    const walk = (n) => {
      if (ts.isJsxText(n)) { out.push(decode(n.text)); return; }
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) { out.push(n.text); return; }
      if (ts.isTemplateExpression(n)) { out.push(n.getText(sf).slice(1, -1)); return; }
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const tag = tagOf(n);
        if (SKIP.has(tag)) return;
        for (const a of attrsOf(n)) if (ts.isJsxAttribute(a) && TEXT_ATTRS.has(a.name.getText(sf)) && a.initializer) walk(a.initializer);
        if (ts.isJsxElement(n)) n.children.forEach(walk);
        return;
      }
      if (ts.isJsxAttribute(n)) return;
      ts.forEachChild(n, walk);
    };
    walk(node);
    return tidy(out.join(' '));
  }

  /** Walk the page in document order, opening a new section at every heading. */
  function visit(n) {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = tagOf(n);
      if (SKIP.has(tag)) return;
      if (tag === 'H1') {
        page.title = text(ts.isJsxElement(n) ? n : n); // H1 children are its title
        page.title = tidy((ts.isJsxElement(n) ? n.children : []).map((c) => text(c)).join(' '));
        const l = attr(n, 'lede'); page.lede = l?.initializer ? text(l.initializer) : '';
        return;
      }
      if (tag === 'H2' || tag === 'H3') {
        const id = strAttr(n, 'id');
        const heading = tidy((ts.isJsxElement(n) ? n.children : []).map((c) => text(c)).join(' '));
        if (!id) problems.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1} ${tag} "${heading}" has no id`);
        cur = { id, level: tag === 'H2' ? 2 : 3, heading, parts: [] };
        page.sections.push(cur);
        return;
      }
      if (ts.isJsxSelfClosingElement(n) || ['P', 'UL', 'OL', 'li', 'Callout', 'Table', 'Pre', 'div', 'span', 'b', 'i', 'C', 'Link', 'a', 'figure', 'figcaption'].includes(tag)) {
        cur.parts.push(text(n));
        return;
      }
      n.children.forEach(visit);   // an unknown wrapper: look inside it for headings
      return;
    }
    if (ts.isJsxFragment(n)) { n.children.forEach(visit); return; }
    if (ts.isJsxText(n)) { const t = tidy(decode(n.text)); if (t) cur.parts.push(t); return; }
    ts.forEachChild(n, visit);
  }

  // Only what the page's default export renders.
  const def = sf.statements.find((s) => (ts.isFunctionDeclaration(s) && s.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)));
  if (!def?.body) problems.push(`${file}: no default-exported page function`);
  else ts.forEachChild(def.body, (s) => { if (ts.isReturnStatement(s) && s.expression) visit(s.expression); });

  return {
    title: page.title, lede: page.lede, problems,
    sections: page.sections.map((s) => ({ id: s.id, level: s.level, heading: s.heading, text: tidy(s.parts.filter(Boolean).join(' ')) }))
      .filter((s) => s.level !== 1 || s.text),
  };
}

const nav = JSON.parse(readFileSync(NAV, 'utf8'));
const listed = nav.sections.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.title })));
const problems = [];

// Every docs page must be in the manifest, and every manifest entry must exist.
const walk = (d) => readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : p.endsWith('page.tsx') ? [relative(ROOT, p)] : []; });
const onDisk = walk(join(ROOT, 'apps/web/app/docs'));
for (const f of onDisk) if (!listed.some((p) => p.file === f)) problems.push(`${f} is a docs page but is not in docs-nav.json`);
for (const p of listed) if (!existsSync(join(ROOT, p.file))) problems.push(`docs-nav.json lists ${p.file}, which does not exist`);

const pages = listed.filter((p) => existsSync(join(ROOT, p.file))).map((p) => {
  const x = extract(p.file);
  problems.push(...x.problems);
  return { href: p.href, title: p.title, section: p.section, h1: x.title, lede: x.lede, sections: x.sections };
});
const json = JSON.stringify({ $comment: 'Generated by scripts/build-docs-index.mjs from the docs page components. Do not edit by hand.', pages }, null, 1) + '\n';

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== json) problems.push('apps/web/lib/docs-index.json is stale: run `node scripts/build-docs-index.mjs`');
  const headings = pages.reduce((n, p) => n + p.sections.filter((s) => s.id).length, 0);
  if (problems.length) { console.log('docs index problems:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log(`  docs index is current: ${pages.length} pages, ${headings} headings, every heading has an id, every page is in the manifest.`);
} else {
  if (problems.length) { console.log('docs index problems:\n  ' + problems.join('\n  ')); process.exit(1); }
  writeFileSync(OUT, json);
  console.log(`  wrote ${relative(ROOT, OUT)}: ${pages.length} pages, ${pages.reduce((n, p) => n + p.sections.length, 0)} sections, ${Math.round(json.length / 1024)} KB`);
}
