/**
 * The gas-tank warning, seen where a person would see it -- the dashboard header, the sign
 * page and the registration API -- in a real browser, against a server whose executor has a
 * genuinely low balance. Nothing is stubbed: the level comes from a real address's balance.
 *
 *   EXPECT=WARNING  WEB_BASE_URL=http://localhost:3017 GAS_ADDRESS=0x... node --env-file=.env scripts/check-gas-warning.mjs
 *
 * Run once per level. EXPECT=ok against the real executor is the negative control: no
 * banner, registration open -- so a check that always "finds" a warning cannot pass it.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { publicClient, readGasTank } from '@retainer/chain';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const EXPECT = process.env.EXPECT || 'ok';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS;
const low = EXPECT !== 'ok';

let pass = 0, fail = 0;
const EXPECTED = 8;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.GAS_ADDRESS) {
  const t = await readGasTank(publicClient(), process.env.GAS_ADDRESS);
  console.log(`executor under test ${process.env.GAS_ADDRESS}: ${t.balanceEth} ETH -> ${t.level}, ~${t.estimatedChargesRemaining} charges, ~${t.estimatedRegistrationsRemaining} registrations`);
}
console.log(`${BASE}, expecting ${EXPECT}`);

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9393', `--user-data-dir=/tmp/retainer-gas-${Date.now()}`], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:9393/json/version')).json(); } catch { /* starting */ } }
let id = 0; const pending = new Map();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S)).result?.result?.value;
async function load(path, width = 1280) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 }, S);
  await send('Page.navigate', { url: BASE + path }, S); await sleep(5000);
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' }, S);
    writeFileSync(join(SHOTS, `gas-${EXPECT}${path.replace(/\//g, '_')}-${width}.png`), Buffer.from(data, 'base64')); }
}

try {
  // The API: what the sign page reads, and what a direct caller gets.
  const pol = await (await fetch(`${BASE}/api/permissions`)).json();
  check(low ? 'the policy says registration is closed, because of gas' : 'the policy says registration is open',
    low ? pol.registrationEnabled === false && pol.registrationClosedReason === 'gas_tank_low' : pol.registrationEnabled === true && pol.registrationClosedReason === null,
    `registrationEnabled=${pol.registrationEnabled} reason=${pol.registrationClosedReason}`);
  const r = await fetch(`${BASE}/api/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'eoa_owned', permission: { account: '0x0000000000000000000000000000000000000001' } }) });
  const j = await r.json();
  check(low ? 'a direct registration is refused 503 gas_tank_low, before anything else' : 'a direct registration is not refused for gas',
    low ? r.status === 503 && j.code === 'gas_tank_low' : j.code !== 'gas_tank_low', `${r.status} ${j.code}`);

  // The dashboard header, on a desktop and a phone.
  for (const w of [1280, 390]) {
    await load('/dashboard', w);
    // The header must have rendered with live data, or "no banner" would prove nothing.
    const header = await js(`document.querySelector('header')?.innerText ?? ''`);
    check(`dashboard header at ${w}px rendered with live chain data`, /chain 84532/.test(header) && /Dashboard/.test(header), header.replace(/\s+/g, ' ').slice(0, 90) || 'no header');
    const alert = await js(`document.querySelector('header [role=alert]')?.innerText ?? null`);
    const want = EXPECT === 'CRITICAL' ? /Executor gas critical/.test(alert ?? '') && /worker has stopped/.test(alert ?? '')
               : EXPECT === 'WARNING' ? /Executor gas low/.test(alert ?? '') && /registrations are closed/.test(alert ?? '') && !/worker has stopped/.test(alert ?? '')
               : alert === null;
    check(`dashboard header at ${w}px ${low ? `shows the ${EXPECT} warning` : 'shows no gas warning'}`, want, alert ? alert.replace(/\s+/g, ' ').slice(0, 170) : 'no banner');
  }

  // The sign page: the customer is told before connecting anything.
  await load('/sign');
  const t = await js('document.body.innerText');
  check(low ? 'the sign page says registration is paused' : 'the sign page does not say registration is paused', low === t.includes('Registration is paused'));
  check('the sign page never shows the "not switched on" banner for a gas pause', !t.includes('Signing is not switched on'));
} catch (e) {
  check(`the check crashed: ${e?.message ?? e}`, false);
} finally {
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
}
