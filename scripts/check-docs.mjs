/**
 * The docs site in a real browser, against any deployment.
 *
 *   - Search finds text INSIDE a page, not only titles: a phrase that appears once, mid-page,
 *     in body text, lands on the page and the heading it sits under, with the phrase in view.
 *   - A phrase on several pages returns results from each, and every result really contains it.
 *   - Negative control: a phrase that appears nowhere returns nothing.
 *   - "On this page" lists the page's headings in order; clicking one scrolls to it and puts it
 *     in the address; scrolling by other means moves the highlight on its own.
 *   - The sidebar shows the manifest's sections in order, marks the open page, and nests its headings.
 *   - On a phone: the table of contents is a drawer that navigates, and "on this page" is inline.
 * Phrases are chosen from the generated index, so the check follows the content as it changes.
 *
 *   WEB_BASE_URL=... SHOTS=<dir> node scripts/check-docs.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS;
const index = JSON.parse(readFileSync(new URL('../apps/web/lib/docs-index.json', import.meta.url), 'utf8'));
const nav = JSON.parse(readFileSync(new URL('../apps/web/lib/docs-nav.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const EXPECTED = 21;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/* ------------------------------------------------ phrases, chosen from what the pages say */
const records = index.pages.flatMap((p) => p.sections.map((s, i) => ({ href: p.href, id: s.id, i, heading: norm(s.heading ?? p.title), title: norm(p.title),
  text: norm(s.id ? s.text : [p.lede, s.text].filter(Boolean).join(' ')) })));
const containing = (ph) => records.filter((r) => r.text.includes(ph) || r.heading.includes(ph) || (!r.id && r.title.includes(ph)));
let unique = null;
for (const r of records) {
  if (!r.id || r.i < 2 || r.text.length < 300 || r.href === '/docs') continue;
  const words = r.text.split(' ');
  for (let start = Math.floor(words.length / 2); start < words.length - 5 && !unique; start++) {
    const ph = words.slice(start, start + 5).join(' ');
    if (!/^[a-z' ,-]+$/.test(ph) || ph.length < 24) continue;          // ordinary words only
    if (containing(ph).length === 1 && !r.heading.includes(ph)) unique = { phrase: ph, href: r.href, id: r.id };
  }
  if (unique) break;
}
let multi = null;
for (const ph of ['reconciler', 'expected payment', 'spend permission', 'smart account', 'review queue']) {
  const pages = new Set(records.filter((r) => r.text.includes(ph)).map((r) => r.href));
  if (pages.size >= 2 && pages.size <= 10) { multi = { phrase: ph, pages }; break; }
}

/* ------------------------------------------------ the browser */
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9396', `--user-data-dir=/tmp/retainer-docs-${Date.now()}`], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:9396/json/version')).json(); } catch { /* starting */ } }
let id = 0; const pending = new Map();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S)).result?.result?.value;
async function until(expr, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await js(expr); if (v) return v; await sleep(250); } return null; }
async function view(width, scheme = 'light') {
  await send('Emulation.setDeviceMetricsOverride', { width, height: width < 500 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 500 }, S);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, S);
}
async function open(path) { await send('Page.navigate', { url: BASE + path }, S); await until(`!!document.querySelector('[data-doc] h1')`, 20000); await sleep(600); }
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' }, S);
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
}
/** Type into the search dialog; return the results it shows. */
async function search(q) {
  await js(`document.querySelector('[data-docs-search-open]').click()`);
  await until(`!!document.querySelector('[data-docs-search-input]')`);
  await js(`document.querySelector('[data-docs-search-input]').focus()`);
  await send('Input.insertText', { text: q }, S);
  await sleep(400);
  return js(`[...document.querySelectorAll('[data-result]')].map((b) => ({ href: b.dataset.resultHref, id: b.dataset.resultId, text: b.innerText }))`);
}
/** The rendered text of one section: its heading through to the next heading. */
const sectionText = (sid) => js(`(() => { const h = document.getElementById(${JSON.stringify(sid)}); if (!h) return null; let t = h.innerText, n = h.nextElementSibling;
  while (n && !/^H[23]$/.test(n.tagName)) { t += ' ' + n.innerText; n = n.nextElementSibling; } return t; })()`);

try {
  console.log(`${BASE}\nunique mid-page phrase: "${unique?.phrase}" (only in ${unique?.href}#${unique?.id})\nmulti-page phrase: "${multi?.phrase}" (${[...(multi?.pages ?? [])].join(', ')})`);
  check('the index yields a phrase found only once, mid-page, in body text', !!unique);

  console.log('\n=== search: a phrase that appears once, mid-page ===');
  await view(1440, 'light'); await open('/docs');
  let res = await search(unique.phrase);
  check('it is found, and the first result is the right page and heading', res?.[0]?.href === unique.href && res?.[0]?.id === unique.id, res?.[0] ? `${res[0].href}#${res[0].id}` : 'no results');
  check('only that one place is returned', res?.length === 1, `${res?.length} result(s)`);
  await shot('search-unique-desktop-light');
  await js(`document.querySelector('[data-result]').click()`);
  const landed = await until(`location.pathname === ${JSON.stringify(unique.href)} && location.hash === ${JSON.stringify('#' + unique.id)}`);
  await sleep(1200);
  check('selecting it navigates to that page and heading', !!landed, await js('location.pathname + location.hash'));
  const top = await js(`document.getElementById(${JSON.stringify(unique.id)})?.getBoundingClientRect().top`);
  check('the heading is scrolled into view, just below the header', top !== undefined && top >= 0 && top < 220, `top ${Math.round(top)}px`);
  check('the phrase is in the rendered text of that section', norm(await sectionText(unique.id) ?? '').includes(unique.phrase));

  console.log('\n=== search: a phrase on several pages ===');
  res = await search(multi.phrase);
  const pagesHit = new Set(res.map((r) => r.href));
  const truly = res.every((r) => containing(multi.phrase).some((c) => c.href === r.href && (c.id ?? '') === r.id));
  check(`results come from several pages (${pagesHit.size})`, pagesHit.size >= 2, [...pagesHit].join(', '));
  check('every result really contains the phrase', truly && res.length > 0, `${res.length} results`);
  check('every page whose text contains it is among the results', [...multi.pages].every((p) => pagesHit.has(p)));
  const other = res.find((r) => r.href !== res[0].href && r.id);
  await js(`[...document.querySelectorAll('[data-result]')].find((b) => b.dataset.resultHref === ${JSON.stringify(other.href)} && b.dataset.resultId === ${JSON.stringify(other.id)}).click()`);
  await until(`location.pathname === ${JSON.stringify(other.href)} && location.hash === ${JSON.stringify('#' + other.id)}`);
  await sleep(1200);
  check(`choosing the result on another page lands there, on its heading, with the phrase in view`,
    (await js('location.pathname + location.hash')) === `${other.href}#${other.id}` && norm(await sectionText(other.id) ?? '').includes(multi.phrase), `${other.href}#${other.id}`);

  console.log('\n=== search: the negative control ===');
  res = await search('zqxv flimwort nonexistent');
  check('a phrase that appears nowhere returns no results, and says so', res.length === 0 && !!(await js(`!!document.querySelector('[data-docs-search-empty]')`)));
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, S);

  console.log('\n=== on this page, and the sidebar (desktop) ===');
  await open('/docs/wallets');
  const domIds = await js(`[...document.querySelectorAll('[data-doc] h2[id], [data-doc] h3[id]')].map((h) => h.id)`);
  const tocIds = await js(`[...document.querySelectorAll('[data-on-this-page="rail"] [data-toc-id]')].map((a) => a.dataset.tocId)`);
  check(`"on this page" lists the page's headings, in order (${tocIds?.length})`, tocIds?.length > 3 && tocIds.join() === domIds.join());
  const pick = tocIds[4];
  await js(`document.querySelector('[data-on-this-page="rail"] [data-toc-id="${pick}"]').click()`);
  await sleep(1500);
  const t2 = await js(`document.getElementById('${pick}').getBoundingClientRect().top`);
  const cur = await js(`document.querySelector('[data-on-this-page="rail"] [aria-current="location"]')?.dataset.tocId`);
  check('clicking a heading scrolls to it, puts it in the address, and highlights it', t2 >= 0 && t2 < 220 && (await js('location.hash')) === `#${pick}` && cur === pick, `top ${Math.round(t2)}px, active ${cur}`);
  const later = tocIds[Math.min(8, tocIds.length - 2)];
  await js(`window.scrollTo(0, document.getElementById('${later}').getBoundingClientRect().top + window.scrollY - 100)`);
  await sleep(700);
  const cur2 = await js(`document.querySelector('[data-on-this-page="rail"] [aria-current="location"]')?.dataset.tocId`);
  check('scrolling by other means moves the highlight on its own', cur2 === later && cur2 !== cur, `now ${cur2}`);
  const secs = await js(`[...document.querySelectorAll('aside [data-docs-section]')].map((s) => s.dataset.docsSection)`);
  check('the sidebar shows the manifest\'s sections, in order', secs?.join('|') === nav.sections.map((s) => s.title).join('|'), secs?.join(' · '));
  const curPage = await js(`document.querySelector('aside [aria-current="page"]')?.dataset.docsPage`);
  const sub = await js(`document.querySelectorAll('aside [data-docs-subnav] a').length`);
  const wantSub = index.pages.find((p) => p.href === '/docs/wallets').sections.filter((s) => s.id && s.level === 2).length;
  check("the open page is marked, and its headings are nested beneath it", curPage === '/docs/wallets' && sub === wantSub, `${curPage}, ${sub}/${wantSub} nested`);
  await js('window.scrollTo(0, 0)'); await sleep(300);
  await shot('docs-desktop-light'); await view(1440, 'dark'); await sleep(400); await shot('docs-desktop-dark');

  console.log('\n=== on a phone ===');
  await view(390, 'light'); await open('/docs/exactly-once');
  check('the sidebar and the right-hand column are hidden; the menu button shows',
    await js(`!document.querySelector('aside [data-docs-section]')?.offsetParent && !document.querySelector('[data-on-this-page="rail"]')?.offsetParent && !!document.querySelector('[data-docs-menu]').offsetParent`));
  check('"on this page" is inline, above the content', !!(await js(`!!document.querySelector('details [data-on-this-page="inline"]')`)));
  await shot('docs-phone-light');
  await js(`document.querySelector('[data-docs-menu]').click()`);
  await until(`!!document.querySelector('[data-docs-drawer]')`);
  check('the menu opens the table of contents, with every section', (await js(`document.querySelectorAll('[data-docs-drawer] [data-docs-section]').length`)) === nav.sections.length);
  await shot('docs-phone-drawer');
  await js(`document.querySelector('[data-docs-drawer] [data-docs-page="/docs/custody"]').click()`);
  await until(`location.pathname === '/docs/custody' && !document.querySelector('[data-docs-drawer]')`);
  check('choosing a page there navigates to it and closes the drawer', (await js('location.pathname')) === '/docs/custody' && !(await js(`!!document.querySelector('[data-docs-drawer]')`)));
  res = await search(unique.phrase);
  await js(`document.querySelector('[data-result]')?.click()`);
  await until(`location.pathname === ${JSON.stringify(unique.href)}`);
  await sleep(1200);
  const tp = await js(`document.getElementById(${JSON.stringify(unique.id)})?.getBoundingClientRect().top`);
  check('search works on a phone too, landing on the heading', (await js('location.hash')) === `#${unique.id}` && tp >= 0 && tp < 220, `top ${Math.round(tp)}px`);
  await view(390, 'dark'); await js('window.scrollTo(0,0)'); await sleep(400); await shot('docs-phone-dark');
} catch (e) {
  check(`the check crashed: ${e?.stack ?? e}`, false);
} finally {
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
}
