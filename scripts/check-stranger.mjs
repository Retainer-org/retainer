/**
 * The site as a stranger sees it: a fresh browser profile, every static route, light and
 * dark, desktop and phone width -- against any deployment, including production.
 *
 * Per route and mode it asserts: the document loads with a 2xx, no uncaught exception or
 * console error, no horizontal scroll, no framework error page, and that the requested
 * colour scheme is the one actually painted. Two negative controls must be seen to fail
 * (a route that does not exist; a page forced wider than the screen), or the run fails.
 *
 *   WEB_BASE_URL=https://retainer-one.vercel.app node scripts/check-stranger.mjs
 *   SHOTS=/tmp/dir  to also save a screenshot per route and mode
 */
import { spawn } from 'node:child_process';
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS;
const APP = 'apps/web/app';

// Every static page in the app router: route groups dropped, dynamic segments skipped.
const walk = (d) => readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? walk(p) : [p]; });
const ROUTES = [...new Set(walk(APP).filter((p) => /\/page\.(tsx|jsx|ts|js)$/.test(p))
  .map((p) => '/' + relative(APP, p).replace(/\/?page\.(tsx|jsx|ts|js)$/, '').split('/').filter((s) => !/^\(.*\)$/.test(s)).join('/'))
  .filter((r) => !r.includes('[')))].sort()
  // SKIP_ROUTES: static routes a deployment deliberately does not serve (e.g. the local-only /sign).
  // EXTRA_ROUTES: dynamic pages worth a stranger's look (e.g. /pay/<token> in each of its states).
  .filter((r) => !(process.env.SKIP_ROUTES ?? '').split(',').includes(r))
  .concat((process.env.EXTRA_ROUTES ?? '').split(',').filter(Boolean));
const MODES = [['light', 1280], ['dark', 1280], ['light', 390], ['dark', 390]];

let pass = 0, fail = 0;
const failures = [];
const record = (label, ok, d = '') => { ok ? pass++ : (fail++, failures.push(`${label}${d ? ` — ${d}` : ''}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9391', `--user-data-dir=/tmp/retainer-stranger-${Date.now()}`], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:9391/json/version')).json(); } catch { /* starting */ } }
if (!ver) { console.error('Chrome did not start'); process.exit(2); }
let id = 0; const pending = new Map(); const events = [];
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true });
for (const d of ['Page', 'Runtime', 'Network', 'Log']) await send(`${d}.enable`, {}, S);
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S)).result?.result?.value;

/** Load one route in one mode and return what a stranger would hit. */
async function visit(route, scheme, width, { forceWide = false } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 }, S);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, S);
  events.length = 0;
  await send('Page.navigate', { url: BASE + route }, S);
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !events.some((e) => e.method === 'Page.loadEventFired')) await sleep(150);
  await sleep(1800);   // client components settle (theme, wallet discovery, live reads)
  if (forceWide) await js(`document.body.appendChild(Object.assign(document.createElement('div'), { style: 'width:3000px;height:4px' }))`);
  const doc = events.find((e) => e.method === 'Network.responseReceived' && e.params.type === 'Document');
  const errors = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
    .map((e) => (e.params.exceptionDetails?.exception?.description ?? e.params.entry?.text ?? e.params.args?.map((a) => a.value ?? a.description).join(' ') ?? '').slice(0, 140));
  const page = JSON.parse(await js(`JSON.stringify({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    text: document.body.innerText.slice(0, 4000),
    bg: getComputedStyle(document.body).backgroundColor,
    dark: document.documentElement.classList.contains('dark') })`));
  // Browsers report computed colours as rgb(), lab() or oklch() depending on how the CSS was written.
  const nums = (page.bg.match(/-?[\d.]+%?/g) || []).map((x) => parseFloat(x));
  const lum = /^lab\(/.test(page.bg) ? nums[0] / 100
            : /^oklch\(|^oklab\(/.test(page.bg) ? (String(page.bg).match(/^ok\w+\(\s*[\d.]+%/) ? nums[0] / 100 : nums[0])
            : (0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2]) / 255;
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' }, S);
    writeFileSync(join(SHOTS, `${route.replace(/\//g, '_') || '_root'}-${scheme}-${width}.png`), Buffer.from(data, 'base64')); }
  return { status: doc?.params.response.status ?? 0, errors, ...page, lum };
}

function judge(label, v, scheme) {
  const probs = [];
  if (!(v.status >= 200 && v.status < 300)) probs.push(`status ${v.status}`);
  if (v.errors.length) probs.push(`console: ${v.errors[0]}`);
  if (v.overflow > 1) probs.push(`scrolls sideways by ${v.overflow}px`);
  if (/Application error|Internal Server Error|This page could not be found/i.test(v.text)) probs.push('framework error page');
  if (scheme === 'dark' ? v.lum > 0.35 : v.lum < 0.65) probs.push(`${scheme} requested, background ${v.bg}`);
  record(label, !probs.length, probs.join('; '));
  return probs;
}

try {
  console.log(`${BASE} — ${ROUTES.length} routes x ${MODES.length} modes, fresh profile`);
  for (const route of ROUTES) {
    const bad = [];
    for (const [scheme, width] of MODES) { const p = judge(`${route} ${scheme} ${width}px`, await visit(route, scheme, width), scheme); if (p.length) bad.push(`${scheme}/${width}: ${p.join('; ')}`); }
    console.log(`  [${bad.length ? 'FAIL' : 'PASS'}] ${route}${bad.length ? ' — ' + bad.join(' | ') : ''}`);
  }
  console.log('\n=== negative controls (each must be caught) ===');
  const c1 = await visit('/definitely-not-a-page', 'light', 1280);
  const caught1 = !(c1.status >= 200 && c1.status < 300) || /could not be found/i.test(c1.text);
  console.log(`  [${caught1 ? 'PASS' : 'FAIL'}] a missing route is detected — status ${c1.status}`); caught1 ? pass++ : (fail++, failures.push('control: missing route not detected'));
  const c2 = await visit('/', 'light', 390, { forceWide: true });
  const caught2 = c2.overflow > 1;
  console.log(`  [${caught2 ? 'PASS' : 'FAIL'}] a page wider than the screen is detected — overflow ${c2.overflow}px`); caught2 ? pass++ : (fail++, failures.push('control: overflow not detected'));
} catch (e) {
  fail++; failures.push(`crashed: ${e?.message ?? e}`);
} finally {
  const expected = ROUTES.length * MODES.length + 2;
  if (pass + fail < expected) { fail++; failures.push(`ran ${pass + fail} of ${expected} assertions`); }
  if (failures.length) console.log('\nFailures:\n  ' + failures.join('\n  '));
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
}
