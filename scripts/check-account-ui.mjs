/**
 * The customer page in a real browser: two wallets and a stranger, one browser, one tab.
 *
 * Nothing is shown before sign-in. Signed in, A sees exactly A's permissions. When the wallet
 * switches to B, A's data leaves the screen at once -- before B has signed anything -- and B
 * must sign in to see B's. A fresh wallet sees only the empty state. The wallet is scripted
 * (EIP-6963), signing in this process with the matching key; it is not MetaMask.
 *
 *   WEB_BASE_URL=... SIGNIN_KEY_A=<file> SIGNIN_KEY_B=<file> SHOTS=<dir> node --env-file=.env scripts/check-account-ui.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { publicClient } from '@retainer/chain';
import { query, close } from '@retainer/db';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS;
const WALLET = 'Scripted wallet';
const A = privateKeyToAccount(readFileSync(process.env.SIGNIN_KEY_A, 'utf8').trim());
const B = privateKeyToAccount(readFileSync(process.env.SIGNIN_KEY_B, 'utf8').trim());
const C = privateKeyToAccount(generatePrivateKey());
const byAddress = Object.fromEntries([A, B, C].map((k) => [k.address.toLowerCase(), k]));
const pub = publicClient();

let pass = 0, fail = 0;
const EXPECTED = 11;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbIds = async (a) => (await query('SELECT id FROM permissions WHERE lower(signer_eoa) = lower($1) ORDER BY id', [a])).rows.map((r) => String(r.id));

const MOCK = `(() => {
  let accounts = [${JSON.stringify(A.address)}]; let seq = 0; const waiting = {}; const listeners = {};
  const emit = (e, v) => (listeners[e] || []).forEach((f) => f(v));
  window.__rpcDone = (id, ok, v) => { const w = waiting[id]; delete waiting[id]; ok ? w.res(v) : w.rej(Object.assign(new Error(v.message), { code: v.code })); };
  window.__setAccount = (a) => { accounts = [a]; emit('accountsChanged', accounts); };
  const provider = {
    request: ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return Promise.resolve(accounts);
      if (method === 'eth_chainId') return Promise.resolve('0x14a34');
      return new Promise((res, rej) => { const id = ++seq; waiting[id] = { res, rej }; window.__rpc(JSON.stringify({ id, method, params: params ?? [] })); });
    },
    on: (e, f) => { (listeners[e] ||= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
  };
  const detail = Object.freeze({ info: { uuid: 'scripted-account', name: ${JSON.stringify(WALLET)}, icon: '', rdns: 'test.scripted' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;

async function walletRequest({ method, params }) {
  if (method === 'eth_signTypedData_v4') {
    const key = byAddress[String(params[0]).toLowerCase()];
    if (!key) throw Object.assign(new Error('unknown account'), { code: 4100 });
    const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    const { EIP712Domain, ...types } = td.types;
    return key.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
  }
  return pub.request({ method, params });
}

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9395', `--user-data-dir=/tmp/retainer-account-${Date.now()}`], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:9395/json/version')).json(); } catch { /* starting */ } }
let id = 0; const pending = new Map(); let S;
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.bindingCalled' && m.params.name === '__rpc') (async () => {
    const req = JSON.parse(m.params.payload); let ok = true, v;
    try { v = await walletRequest(req); } catch (err) { ok = false; v = { message: err?.shortMessage ?? err?.message ?? String(err), code: err?.code ?? -32603 }; }
    await send('Runtime.evaluate', { expression: `window.__rpcDone(${req.id}, ${ok}, ${JSON.stringify(v ?? null)})` }, S);
  })();
};
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
({ result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true }));
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
await send('Runtime.addBinding', { name: '__rpc' }, S);
await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK }, S);
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S)).result?.result?.value;
const shown = () => js(`[...document.querySelectorAll('[data-permission]')].map((e) => e.dataset.permission).sort((a, b) => a - b)`);
const text = () => js('document.body.innerText');
const click = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(label)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
async function until(fn, ms = 30000) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(300); } return v; }
async function shot(name, width, scheme) {
  if (!SHOTS) return;
  await send('Emulation.setDeviceMetricsOverride', { width, height: 1600, deviceScaleFactor: 1, mobile: width < 500 }, S);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, S);
  await sleep(700);
  mkdirSync(SHOTS, { recursive: true });
  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
  writeFileSync(join(SHOTS, `${name}-${scheme}-${width}.png`), Buffer.from(data, 'base64'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false }, S);
}
const same = (x, y) => x.join() === y.join();

try {
  const aIds = await dbIds(A.address), bIds = await dbIds(B.address);
  console.log(`${BASE}\nA ${A.address} owns [${aIds}] · B ${B.address} owns [${bIds}] · C ${C.address} owns nothing`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false }, S);
  await send('Page.navigate', { url: `${BASE}/account` }, S);
  await until(async () => (await text()).includes(WALLET));
  check('the privacy caveat is on the page before anything is connected', /does not make them private/.test(await text()));
  check(`"${WALLET}" is offered`, await click(WALLET));
  await until(async () => (await text()).includes('Sign in with'));
  check('connected but not signed in: no permissions are shown', (await shown()).length === 0);

  console.log('\n=== A signs in ===');
  check('clicking "Sign in" works', await click('Sign in with'));
  const gotA = await until(async () => { const s = await shown(); return s.length ? s : null; }) ?? [];
  check("A sees exactly A's permissions", same(gotA, aIds), `[${gotA}]`);
  check("and none of B's", gotA.every((i) => !bIds.includes(i)));
  await shot('account-A', 390, 'light'); await shot('account-A', 390, 'dark'); await shot('account-A', 1280, 'dark');

  console.log('\n=== the wallet switches to B ===');
  await js(`window.__setAccount(${JSON.stringify(B.address)})`);
  const cleared = await until(async () => (await shown()).length === 0, 3000);
  check("A's permissions leave the screen at once, before B signs anything", cleared === true);
  check('the page says which account is signed in and asks B to sign in', /signed in as/.test(await text()) && (await text()).includes('Sign in with'));
  await click('Sign in with');
  const gotB = await until(async () => { const s = await shown(); return s.length ? s : null; }) ?? [];
  check("B sees exactly B's permissions, and none of A's", same(gotB, bIds) && gotB.every((i) => !aIds.includes(i)), `[${gotB}]`);

  console.log('\n=== a stranger ===');
  await js(`window.__setAccount(${JSON.stringify(C.address)})`);
  await until(async () => (await shown()).length === 0, 3000);
  await click('Sign in with');
  const empty = await until(async () => (await text()).includes('No permissions for'));
  check('a fresh wallet signs in and sees only the empty state', !!empty && (await shown()).length === 0);
  const server = await js(`fetch('/api/me/permissions').then((r) => r.json())`);
  check('and the server agrees: its session returns nothing', server?.address === C.address.toLowerCase() && server.permissions?.length === 0);
  await shot('account-empty', 390, 'dark');
} catch (e) {
  check(`the check crashed: ${e?.stack ?? e}`, false);
} finally {
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill(); await close(); process.exit(fail ? 1 : 0);
}
