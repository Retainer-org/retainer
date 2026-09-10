/**
 * The sign page's account and network handling, exercised in a real browser.
 *
 * Two real MetaMask sessions found things no drill could: a wallet already on another
 * network had no way forward, and switching accounts left the page describing the
 * wrong one. Both are about what the page tells the person, not about the chain --
 * so they are tested here, in headless Chrome, against the real chain and database.
 *
 * The wallet is a scripted EIP-1193 provider announced over EIP-6963, NOT MetaMask:
 * this proves the page's behaviour for the events a wallet sends, not what MetaMask
 * displays. It never signs anything.
 *
 * Each expected state is asserted BEFORE the action that should change it, so the
 * later assertion proves a change happened rather than a state that was never there.
 *
 *   npm run check:sign-ui      (needs Google Chrome and the dev server on :3017)
 */
import { spawn } from 'node:child_process';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SEVEN702 = '0x2C5d65A0dA493e53E78c6c15866745a9CD83a33a';  // upgraded by MetaMask; registered and revoked #20
const RETURNING = '0xaC033336e519b69aA37E7a085E68951A50A5648B'; // upgraded by MetaMask; #18 revoked, #19 active
const FRESH = privateKeyToAccount(generatePrivateKey()).address;   // a standard account with nothing registered

let pass = 0, fail = 0;
const EXPECTED = 21;  // assertions in a complete run; fewer means the check stopped short
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Injected before any page script runs.
const MOCK = `(() => {
  const listeners = {};
  const st = { accounts: [${JSON.stringify(SEVEN702)}], chainId: '0xc488', calls: [], rejectSwitchOnce: true };
  const emit = (ev, v) => (listeners[ev] || []).forEach((f) => f(v));
  const provider = {
    request: async ({ method, params }) => {
      st.calls.push(method);
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return st.accounts;
        case 'eth_chainId': return st.chainId;
        case 'wallet_switchEthereumChain':
          if (st.rejectSwitchOnce) { st.rejectSwitchOnce = false; throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); }
          st.chainId = params[0].chainId; emit('chainChanged', st.chainId); return null;
        case 'wallet_requestPermissions':
          st.accounts = [window.__mock.nextAccount]; emit('accountsChanged', st.accounts); return [{ parentCapability: 'eth_accounts' }];
        default: throw Object.assign(new Error('scripted wallet: ' + method + ' not supported'), { code: 4200 });
      }
    },
    on: (ev, f) => { (listeners[ev] ||= []).push(f); },
    removeListener: (ev, f) => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); },
  };
  window.__mock = { st, emit, nextAccount: null };
  const detail = Object.freeze({ info: { uuid: 'scripted-1', name: 'MetaMask', icon: '', rdns: 'test.scripted' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  try { sessionStorage.setItem('retainer.sign.registered', JSON.stringify([{ eoa: ${JSON.stringify(RETURNING)}, permissionId: '19' }])); } catch {}
})();`;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9390', `--user-data-dir=/tmp/retainer-sign-ui-${Date.now()}`], { stdio: 'ignore' });
let ver = null;
for (let i = 0; i < 40 && !ver; i++) { await sleep(300); try { ver = await (await fetch('http://127.0.0.1:9390/json/version')).json(); } catch { /* starting */ } }
if (!ver) { console.error('Chrome did not start'); process.exit(2); }
let id = 0; const pending = new Map();
const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: S } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1800, deviceScaleFactor: 1, mobile: false }, S);
await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK }, S);

const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S)).result?.result?.value;
const text = () => js('document.body.innerText');
const click = (label) => js(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(${JSON.stringify(label)}) && !x.disabled); if (!b) return false; b.click(); return true; })()`);
async function until(pred, ms = 25000) { const t0 = Date.now(); let t = ''; while (Date.now() - t0 < ms) { t = await text(); if (pred(t)) return t; await sleep(400); } return t; }

try {
  await send('Page.navigate', { url: `${BASE}/sign` }, S);
  await until((t) => t.includes('Connect a wallet'));
  check('the scripted wallet is discovered over EIP-6963', await click('MetaMask'));

  console.log('\n=== connected to a 7702-upgraded account, on the wrong network ===');
  let t = await until((t) => t.includes('upgraded to a smart account'));
  check('the connected account is shown prominently', t.includes('Connected account in MetaMask') && t.includes(SEVEN702));
  check('the 7702 refusal is shown for that account', t.includes('upgraded to a smart account (EIP-7702)'));
  check('the refusal offers "Switch account in MetaMask"', t.includes('Switch account in MetaMask'));
  check('the refusal offers "Use a Base Account instead"', t.includes('Use a Base Account instead'));
  check('it says the account differs from the one that registered earlier in this session', t.includes('This is a different account') && t.includes('permission #19'));
  t = await until((t) => t.includes('#20'));
  check('its existing permissions are listed even though the owner is refused', t.includes('#20'));
  check('the auto-switch was declined, so the network check fails and offers a button', t.includes('Switch to Base Sepolia'));

  console.log('\n=== the network button ===');
  check('clicking "Switch to Base Sepolia" works', await click('Switch to Base Sepolia'));
  t = await until((t) => !t.includes('Switch to Base Sepolia'));
  check('the network check passes and the button is gone', !t.includes('Switch to Base Sepolia'), await js('window.__mock.st.chainId'));

  console.log('\n=== switching to a standard account from the page ===');
  await js(`window.__mock.nextAccount = ${JSON.stringify(FRESH)}`);
  check('clicking "Switch account in MetaMask" works', await click('Switch account in MetaMask'));
  check('it asked the wallet for its account picker (wallet_requestPermissions)', (await js('window.__mock.st.calls')).includes('wallet_requestPermissions'));
  t = await until((t) => t.includes(FRESH) && t.includes('Check the fingerprint'));
  check('the page now describes the new account', t.includes(FRESH));
  check('no stale refusal: the 7702 panel is gone', !t.includes('upgraded to a smart account'));
  check('the flow continues for the new account (funding and fingerprint steps)', t.includes('Put USDC in your smart account') && t.includes('Check the fingerprint'));

  console.log('\n=== the account changes inside the wallet (accountsChanged) ===');
  await js(`window.__mock.st.accounts = [${JSON.stringify(SEVEN702)}]; window.__mock.emit('accountsChanged', [${JSON.stringify(SEVEN702)}])`);
  t = await until((t) => t.includes('upgraded to a smart account'));
  check('switching back in the wallet re-runs the checks: the refusal returns, live', t.includes(SEVEN702) && t.includes('upgraded to a smart account'));
  check('and the funding and fingerprint steps are gone again', !t.includes('Check the fingerprint'));

  console.log('\n=== the returning customer, whose account MetaMask upgraded when they revoked ===');
  await js(`window.__mock.st.accounts = [${JSON.stringify(RETURNING)}]; window.__mock.emit('accountsChanged', [${JSON.stringify(RETURNING)}])`);
  t = await until((t) => t.includes(RETURNING) && t.includes('#19'));
  check('their permissions are still listed', t.includes('#18') && t.includes('#19'));
  const revokable = await js(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Revoke' && !b.disabled)`);
  check('#19 can still be revoked from the page', revokable === true);
  check('no "different account" notice for the account that registered in this session', !t.includes('This is a different account'));
  check('the refusal says existing permissions keep working', t.includes('keep working'));

  const { result: { data } } = await send('Page.captureScreenshot', { format: 'png' }, S);
  const out = process.env.SIGN_UI_SHOT; if (out) { (await import('node:fs')).writeFileSync(out, Buffer.from(data, 'base64')); console.log(`\n  screenshot: ${out}`); }
} catch (e) {
  // An exception is a failure, never a silent exit: a check that stops early must not read as a pass.
  check(`the check crashed: ${e?.message ?? e}`, false);
} finally {
  if (pass + fail < EXPECTED) check(`the check ran to completion (${pass + fail} of ${EXPECTED} assertions)`, false);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
}
