/**
 * The whole public flow against a live deployment, the way a customer does it, with the
 * transaction hashes that deployment produced:
 *
 *   read the terms -> connect -> fund the smart account -> sign -> registered by the
 *   deployment's executor -> charged by the hosted worker -> revoked from the page
 *
 * Driven through the real /sign page in headless Chrome. The wallet is a scripted EIP-1193
 * provider announced over EIP-6963; its signing and sending happen in this process with a
 * fresh throwaway key. It is NOT MetaMask: it proves the deployment, not what MetaMask shows.
 * On the way it also asserts the per-signer rate limit with a second, validly signed
 * registration, and that the refusal sent nothing.
 *
 * It arrives the way a customer does: through the demo merchant's billing link (/try). The link's
 * plan takes the first charge at signup; the script charges nothing itself -- it watches the page
 * the customer is on, and the worker that is running, take it.
 *
 * Spends testnet funds: ETH from TEST_USER for gas, 2 USDC from the treasury. The throwaway
 * key is written (mode 600) under LOOP_KEY_DIR so anything left over stays recoverable.
 *
 *   WEB_BASE_URL=https://retainer-one.vercel.app node --env-file=.env scripts/public-loop.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWalletClient, http, parseEther, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { publicClient, config, toStruct, smartWalletTypedData, spendPermissionManagerAbi } from '@retainer/chain';
import { query, close } from '@retainer/db';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WALLET = 'Scripted wallet';
const cfg = config();
const pub = publicClient();
const rpc = http(process.env.BASE_SEPOLIA_RPC_URL);
const erc20 = parseAbi(['function transfer(address to, uint256 value) returns (bool)']);
const managerReads = parseAbi(['function isRevoked((address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData) spendPermission) view returns (bool)']);

let pass = 0, fail = 0;
const EXPECTED = 24;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); return ok; };
const hashes = [];
const note = (label, hash) => { hashes.push([label, hash]); console.log(`  tx  ${label}: ${hash}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ser = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
const one = async (sql, p) => (await query(sql, p)).rows[0];

// ------------------------------------------------------------------ the customer
// LOOP_KEY_FILE reuses a customer from an earlier run (already funded), instead of making a new one.
const pk = process.env.LOOP_KEY_FILE ? readFileSync(process.env.LOOP_KEY_FILE, 'utf8').trim() : generatePrivateKey();
const me = privateKeyToAccount(pk);
const keyFile = process.env.LOOP_KEY_FILE || join(process.env.LOOP_KEY_DIR || tmpdir(), `retainer-public-loop-${me.address}.key`);
if (!process.env.LOOP_KEY_FILE) writeFileSync(keyFile, `${pk}\n`, { mode: 0o600 });
const customer = createWalletClient({ account: me, chain: baseSepolia, transport: rpc });
console.log(`${BASE}\ncustomer EOA ${me.address} (throwaway key: ${keyFile})`);

/** The scripted wallet's side: everything a wallet signs or sends happens here. */
async function walletRequest({ method, params }) {
  if (method === 'eth_signTypedData_v4') {
    const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
    const { EIP712Domain, ...types } = td.types;
    return me.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
  }
  if (method === 'eth_sendTransaction') {
    const t = params[0];
    return customer.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n, ...(t.gas ? { gas: BigInt(t.gas) } : {}) });
  }
  return pub.request({ method, params });
}

const MOCK = `(() => {
  const EOA = ${JSON.stringify(me.address)};
  let seq = 0; const waiting = {};
  window.__rpcDone = (id, ok, v) => { const w = waiting[id]; delete waiting[id]; ok ? w.res(v) : w.rej(Object.assign(new Error(v.message), { code: v.code })); };
  const listeners = {};
  const provider = {
    request: ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return Promise.resolve([EOA]);
      if (method === 'eth_chainId') return Promise.resolve('0x14a34');
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return Promise.resolve(null);
      if (method === 'wallet_requestPermissions') return Promise.resolve([{ parentCapability: 'eth_accounts' }]);
      return new Promise((res, rej) => { const id = ++seq; waiting[id] = { res, rej }; window.__rpc(JSON.stringify({ id, method, params: params ?? [] })); });
    },
    on: (e, f) => { (listeners[e] ||= []).push(f); },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
  };
  const detail = Object.freeze({ info: { uuid: 'scripted-public-loop', name: ${JSON.stringify(WALLET)}, icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.scripted' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9394', `--user-data-dir=/tmp/retainer-loop-${Date.now()}`], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:9394/json/version')).json(); } catch { /* starting */ } }
let id = 0; const pending = new Map();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
let S;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.bindingCalled' && m.params.name === '__rpc') {
    (async () => {
      const req = JSON.parse(m.params.payload); let ok = true, v;
      try { v = await walletRequest(req); } catch (err) { ok = false; v = { message: err?.shortMessage ?? err?.message ?? String(err), code: err?.code ?? -32603 }; }
      await send('Runtime.evaluate', { expression: `window.__rpcDone(${req.id}, ${ok}, ${JSON.stringify(v ?? null)})` }, S);
    })();
  }
};
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
({ result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true }));
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
await send('Runtime.addBinding', { name: '__rpc' }, S);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false }, S);
await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK }, S);
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S)).result?.result?.value;
const text = () => js('document.body.innerText');
const enabled = (label, exact = false) => `[...document.querySelectorAll('button')].some((x) => (${exact} ? x.textContent.trim() === ${JSON.stringify(label)} : x.textContent.includes(${JSON.stringify(label)})) && !x.disabled)`;
const clickNow = (label, exact = false) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (${exact} ? x.textContent.trim() === ${JSON.stringify(label)} : x.textContent.includes(${JSON.stringify(label)})) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
/** Click once the button is enabled -- a page's buttons wait on async checks, and so does a person. */
async function click(label, exact = false, ms = 60000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(enabled(label, exact))) return clickNow(label, exact); await sleep(400); } return false; }
async function until(pred, ms = 30000) { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await text(); if (pred(t)) return t; await sleep(500); } return t; }
async function untilJs(expr, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(expr)) return true; await sleep(500); } return false; }
async function poll(fn, ms, every = 5000) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await fn(); if (v?.done) return v; await sleep(every); } return v; }

try {
  // ------------------------------------------------ 0. the customer gets test funds
  console.log('\n=== setup: the customer gets testnet funds, as from a faucet ===');
  const gasSrc = createWalletClient({ account: privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY), chain: baseSepolia, transport: rpc });
  const treasury = createWalletClient({ account: privateKeyToAccount(process.env.MERCHANT_TREASURY_PRIVATE_KEY), chain: baseSepolia, transport: rpc });
  const usdcOf = (a) => pub.readContract({ address: cfg.usdc, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [a] });
  let h;
  if ((await pub.getBalance({ address: me.address })) < parseEther('0.0002')) {
    h = await gasSrc.sendTransaction({ to: me.address, value: parseEther('0.0004') });
    await pub.waitForTransactionReceipt({ hash: h }); note('setup: gas to the customer', h);
  } else console.log('  customer already has gas');
  if ((await usdcOf(me.address)) < 2_000_000n) {
    if ((await pub.getBalance({ address: treasury.account.address })) < parseEther('0.00002')) {
      h = await gasSrc.sendTransaction({ to: treasury.account.address, value: parseEther('0.00003') });
      await pub.waitForTransactionReceipt({ hash: h }); note('setup: gas to the treasury, to send test USDC', h);
    }
    h = await treasury.writeContract({ address: cfg.usdc, abi: erc20, functionName: 'transfer', args: [me.address, 2_000_000n] });
    await pub.waitForTransactionReceipt({ hash: h }); note('setup: 2 test USDC to the customer', h);
  } else console.log('  customer already has 2 USDC');

  // ------------------------------------------------ 1. arriving from the merchant's link
  console.log("\n=== the demo merchant's link (/try) ===");
  const LINK = (await fetch(`${BASE}/try`, { redirect: 'manual' })).headers.get('location')?.split('/pay/')[1] ?? null;
  check("/try redirects to the demo merchant's billing link", !!LINK, LINK ?? 'no redirect');
  const lv = await (await fetch(`${BASE}/api/links/${LINK}`)).json();
  const FIRST = BigInt(lv.link.firstChargeAmount ?? 0);
  const first$ = (Number(FIRST) / 1e6).toFixed(2);
  await send('Page.navigate', { url: `${BASE}/try` }, S);
  let t = await until((t) => t.includes(WALLET));
  check('the merchant is named, and the terms are on the page before anything is connected',
    t.includes(`${lv.link.merchantName} is asking you to authorise payments`) && t.includes('What you are agreeing to'));
  check(`the terms say when the first charge is taken: ${first$} USDC, as soon as you sign`,
    t.includes('When you are charged') && t.includes(`The first ${first$} USDC is taken as soon as you sign`));
  check('the payee address is shown beside the name, and the name is marked as not verified', t.includes('is the name on this link, not a verified identity'));
  check(`"${WALLET}" is offered as a wallet (EIP-6963)`, await click(WALLET));
  t = await until((t) => t.includes(me.address) && t.includes('Send 2.00 USDC'), 60000);
  check('the connected account is shown, and funding is offered', t.includes(me.address) && t.includes('Send 2.00 USDC'));
  check('the terms say at most 2.00 USDC in any day', /at most 2(\.00)? USDC in any day/.test(t), (t.match(/at most[^\n]{0,60}/) || [''])[0]);
  check('no "fund it later" option: the first charge needs the money there first', !t.includes("I'll fund it after signing"));
  const signEnabled = `[...document.querySelectorAll('button')].some((b) => b.textContent.includes(${JSON.stringify(`Sign with ${WALLET}`)}) && !b.disabled)`;
  check('before funding, the sign button is not enabled', !(await js(signEnabled)));
  check('clicking "Send 2.00 USDC" works', await click('Send 2.00 USDC'));
  check('once funded, the sign button is enabled', await untilJs(signEnabled, 120000));
  const fundTx = (await js(`[...document.querySelectorAll('a')].map((a) => a.href).find((u) => /\\/tx\\/0x/.test(u)) ?? null`))?.match(/0x[0-9a-fA-F]{64}/)?.[0];
  if (fundTx) note('customer funded their smart account from the page', fundTx);

  check(`clicking "Sign with ${WALLET}" works`, await click(`Sign with ${WALLET}`));
  t = await until((t) => t.includes('is live') || /refused|could not|not what this link/i.test(t), 120000);
  check('the page says it is authorised — on the same page, with no sign-in', /Permission #\d+ is live/.test(t), /is live/.test(t) ? '' : t.slice(0, 300).replace(/\s+/g, ' '));

  const perm = await one(`SELECT p.id, p.permission_hash, p.account, p.spender, p.token, p.allowance, p.period_seconds, p.start_ts, p.end_ts, p.salt, p.extra_data,
                                 p.approved_tx_hash, p.signing_path::text AS signing_path, p.signer_eoa, p.created_at, l.token AS link_token
                            FROM permissions p LEFT JOIN billing_links l ON l.id = p.link_id
                           WHERE lower(p.signer_eoa) = lower($1) ORDER BY p.id DESC LIMIT 1`, [me.address]);
  const struct = perm && toStruct({ account: perm.account, spender: perm.spender, token: perm.token, allowance: perm.allowance,
    period: perm.period_seconds, start: perm.start_ts, end: perm.end_ts, salt: perm.salt, extraData: perm.extra_data });
  const reg = perm?.approved_tx_hash ? await pub.waitForTransactionReceipt({ hash: perm.approved_tx_hash }) : null;
  check("stored against the demo merchant's link, signed via an ordinary wallet, registered by the deployment executor",
    perm?.link_token === LINK && perm?.signing_path === 'eoa_owned' && reg?.status === 'success' && getAddress(reg.from) === getAddress(cfg.executor),
    perm ? `permission #${perm.id}, link ${perm.link_token}` : 'no permission stored');
  if (perm) note(`registration: permission #${perm.id} (one signature, smart account created)`, perm.approved_tx_hash);

  // ------------------------------------------------ 2. the per-signer rate limit, live
  console.log('\n=== a second registration by the same signer ===');
  const pol = lv.policy;
  const now = Math.floor(Date.now() / 1000);
  const s2 = toStruct({ account: perm.account, spender: pol.router, token: pol.usdc, allowance: pol.allowance, period: pol.periodSeconds,
    start: now, end: now + pol.durationSeconds, salt: BigInt(Date.now()), extraData: pol.extraData });
  const h2 = await pub.readContract({ address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [s2] });
  const sig2 = await me.signTypedData(smartWalletTypedData(perm.account, cfg.chainId, h2));
  const n0 = await pub.getTransactionCount({ address: cfg.executor, blockTag: 'pending' });
  const r2 = await fetch(`${BASE}/api/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'eoa_owned', signerEoa: me.address, permission: ser(s2), permissionHash: h2, signature: sig2, link: LINK }) });
  const j2 = await r2.json();
  const n1 = await pub.getTransactionCount({ address: cfg.executor, blockTag: 'pending' });
  const stored2 = await one(`SELECT count(*)::int AS c FROM permissions WHERE permission_hash = $1`, [h2]);
  check('a validly signed second registration is refused 429 rate_limited', r2.status === 429 && j2.code === 'rate_limited', `${r2.status} ${j2.code}: ${j2.error ?? ''}`);
  check('and the refusal sent nothing and stored nothing', n0 === n1 && stored2.c === 0, `executor nonce ${n0} -> ${n1}, rows ${stored2.c}`);

  // ------------------------------------------------ 3. the first charge, scheduled by the link and watched on the page
  console.log('\n=== the first charge, watched on the same page ===');
  const stages = []; const t0 = Date.now();
  while (Date.now() - t0 < 10 * 60_000) {
    const st = await js(`document.querySelector('[data-first-charge]')?.dataset.firstCharge ?? null`);
    if (st && stages.at(-1) !== st) stages.push(st);
    if (st === 'confirmed' || st === 'failed_terminal') break;
    await sleep(1500);
  }
  const txt = await text();
  const chargeTx = (await js(`[...document.querySelectorAll('[data-first-charge] a')].map((a) => a.href).filter((u) => /\/tx\//.test(u)).pop() ?? null`))?.match(/0x[0-9a-fA-F]{64}/)?.[0];
  check(`the page showed the first charge through to confirmed, with the settled amount and a Basescan link`,
    new RegExp(`Confirmed — ${first$} USDC settled to `).test(txt) && !!chargeTx, `stages seen: ${stages.join(' → ')}`);
  const charges = (await query(`SELECT c.id, c.state::text AS s, c.amount, c.confirmed_tx_hash, c.confirmed_amount, c.created_at = p.created_at AS same_tx
                                  FROM charges c JOIN permissions p ON p.id = c.permission_id WHERE c.permission_id = $1`, [perm.id])).rows;
  check('exactly one charge exists for it, created in the same database transaction as the permission',
    charges.length === 1 && charges[0].same_tx === true, `${charges.length} charge(s), same transaction: ${charges[0]?.same_tx}`);
  const c1 = charges[0];
  const rc = c1?.confirmed_tx_hash ? await pub.waitForTransactionReceipt({ hash: c1.confirmed_tx_hash }) : null;
  check("confirmed for exactly the link's first amount, sent by the executor, and it is the transaction the page linked",
    c1?.s === 'confirmed' && BigInt(c1.confirmed_amount ?? 0) === FIRST && rc?.status === 'success' && getAddress(rc.from) === getAddress(cfg.executor) && c1.confirmed_tx_hash === chargeTx,
    `#${c1?.id} ${c1?.s} ${c1?.confirmed_amount}`);
  if (c1?.confirmed_tx_hash) note(`first charge #${c1.id}: ${first$} USDC to the merchant, scheduled by the link`, c1.confirmed_tx_hash);
  const chargeId = c1?.id;
  const ep = await poll(async () => {
    const r = await one(`SELECT ep.id, ep.state::text AS s FROM expected_payments ep JOIN charges c ON c.expected_payment_id = ep.id WHERE c.id = $1`, [chargeId]);
    return { ...r, done: r.s === 'paid' };
  }, 90_000, 3000);
  check('its expected payment is settled (paid)', ep?.s === 'paid', `expected payment #${ep?.id}: ${ep?.s}`);

  // ------------------------------------------------ 4. revoked by the customer, from their permissions page
  console.log('\n=== revoke, from /account ===');
  await send('Page.navigate', { url: `${BASE}/account` }, S);
  await until((t) => t.includes(WALLET)); await click(WALLET);
  await click('Sign in with');
  await untilJs(`!!document.querySelector('[data-permission="${perm.id}"]')`, 60000);
  if (process.env.SHOTS) {   // the active card, with a real charge against it, as the customer sees it
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(process.env.SHOTS, { recursive: true });
    for (const [w, scheme] of [[390, 'light'], [390, 'dark'], [1280, 'light']]) {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: 1800, deviceScaleFactor: 1, mobile: w < 500 }, S);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, S);
      await sleep(800);
      const { result: { data } } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, S);
      writeFileSync(join(process.env.SHOTS, `account-active-${scheme}-${w}.png`), Buffer.from(data, 'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false }, S);
  }
  await click('Revoke…');
  check('revoking asks for confirmation first, saying what it does', await untilJs(`/No further charges can be taken under it/.test(document.body.innerText)`, 10000));
  await click('Revoke permission');
  const rv = await poll(async () => {
    const r = await one(`SELECT revoked_tx_hash, revoked_at FROM permissions WHERE id = $1`, [perm.id]);
    return { ...r, done: !!r.revoked_tx_hash };
  }, 120_000, 3000);
  check('the revoke was recorded (only after its receipt, event and isRevoked were verified server-side)', !!rv?.revoked_tx_hash);
  if (rv?.revoked_tx_hash) {
    const rr = await pub.waitForTransactionReceipt({ hash: rv.revoked_tx_hash });
    const revoked = await pub.readContract({ address: cfg.manager, abi: managerReads, functionName: 'isRevoked', args: [struct], blockNumber: rr.blockNumber });
    check('sent by the customer, succeeded, and the manager reports it revoked at that block', rr.status === 'success' && getAddress(rr.from) === getAddress(me.address) && revoked === true);
    note(`customer revoked permission #${perm.id} from the page`, rv.revoked_tx_hash);
  } else check('sent by the customer, succeeded, and the manager reports it revoked at that block', false, 'no revoke recorded');
  // The permission's own card must say Revoked, with its transaction -- and no error on the page.
  const cardText = `document.querySelector('[data-permission="${perm.id}"]')?.innerText ?? ''`;
  await untilJs(`/Revoked in/.test(${cardText})`, 20000);
  const row = await js(cardText); const errBox = await js(`document.querySelector('.bg-red-500\\/10')?.innerText ?? null`);
  check(`the permissions page shows #${perm.id} as revoked, with its transaction, and no error`, /Revoked in 0x/.test(row) && !errBox, errBox ?? row.replace(/\s+/g, ' ').slice(0, 200));
} catch (e) {
  check(`the loop crashed: ${e?.stack ?? e?.message ?? e}`, false);
} finally {
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log('\nTransactions from this run:');
  for (const [l, h] of hashes) console.log(`  ${h}  ${l}`);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill(); await close(); process.exit(fail ? 1 : 0);
}
