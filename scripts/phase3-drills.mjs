/**
 * Phase 3: an EOA-owned smart account, end to end, through the real endpoint.
 *
 * A fresh key stands in for a MetaMask account. It signs exactly what the sign
 * page asks a wallet to sign, and everything after that is the production path:
 * POST /api/permissions (policy, owner code, signature diagnosis, rate limits,
 * simulate, ERC-6492 deploy + approve), then a real charge through the charger
 * and the reconciler, a real EIP-7702 upgrade of the owner after approval, and a
 * real revocation sent by the customer's own key.
 *
 * Every refusal is asserted twice over: the right reason, AND no transaction
 * sent (executor nonce unchanged) AND no row written (permission count unchanged).
 * A refusal that silently spent gas would pass a status-code check.
 *
 * The drill removes its own database rows at the end. Its transactions stay on
 * Base Sepolia and are printed as evidence.
 *
 * Needs the dev server (npm run dev -w @retainer/web) with .env loaded.
 */
import { createWalletClient, http, encodeFunctionData, parseAbi, getAddress, parseEther, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { publicClient, config, toStruct, periodFor, classify, deriveSmartAccount, smartWalletTypedData,
  smartWalletAbi, classifyOwnerCode, erc20Abi, spendRouterAbi, SMART_WALLET_FACTORY, checkOwner, TRUSTED_7702_DELEGATES } from '@retainer/chain';
import { query, close } from '@retainer/db';
import { claimCharge, attemptCharge } from '../apps/worker/src/charger.js';
import { recoverOpenAttempts } from '../apps/worker/src/recovery.js';
import { indexEvents, confirmCharges } from '../apps/worker/src/reconciler.js';
import { indexIncomingTransfers } from '../apps/worker/src/watcher.js';
import { settleFromConfirmedCharges } from '../apps/worker/src/sweep.js';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const cfg = config(), pub = publicClient();
const T = '(address account,address spender,address token,uint160 allowance,uint48 period,uint48 start,uint48 end,uint256 salt,bytes extraData)';
const mgr = parseAbi([`function getHash(${T} p) view returns (bytes32)`, `function isApproved(${T} p) view returns (bool)`,
  `function isRevoked(${T} p) view returns (bool)`, `function revoke(${T} p)`]);
const exec = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY);
const execW = createWalletClient({ account: exec, chain: baseSepolia, transport: http(cfg.rpcUrl) });
const funder = privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY);      // owns the Phase 1 wallet that holds test USDC
const funderW = createWalletClient({ account: funder, chain: baseSepolia, transport: http(cfg.rpcUrl) });
const FUND_WALLET = getAddress(process.env.TEST_SMART_WALLET);
// Throwaway customer keys are appended here (never printed), so anything a crashed run
// leaves in its smart account can be recovered rather than stranded.
const KEY_LOG = process.env.DRILL_KEY_LOG ?? '/tmp/retainer-phase3-drill-keys.log';

let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const ev = {};                                   // evidence: step -> tx hash
const made = { permissionIds: [], chargeIds: [], expectedPaymentIds: [], customerIds: [], txs: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (h) => { const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error(`reverted: ${h}`); return r; };
/**
 * Read state AS OF a receipt's block. The public RPC load-balances across nodes that can
 * lag the one that returned the receipt; an unpinned read can answer from before the
 * transaction. Pinned, a lagging node errors instead of lying, and we retry. Without this
 * a check can pass or fail against state from before the thing it is checking.
 */
async function at(receipt, read) {
  let last;
  for (let i = 0; i < 20; i++) {
    try { return await read({ blockNumber: receipt.blockNumber }); } catch (e) { last = e; await sleep(1000); }
  }
  throw new Error(`no node served block ${receipt.blockNumber}: ${last?.shortMessage ?? last?.message}`);
}

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const nonceOf = () => pub.getTransactionCount({ address: exec.address, blockTag: 'pending' });
const permCount = async () => (await query('SELECT count(*)::int AS c FROM permissions')).rows[0].c;

/** A refusal must give the right reason and cost nothing: no transaction, no row. */
async function refused(label, body, status, code, field) {
  const [n0, c0] = [await nonceOf(), await permCount()];
  const r = await post('/api/permissions', body);
  const [n1, c1] = [await nonceOf(), await permCount()];
  const right = r.status === status && r.body.code === code && (!field || r.body.field === field);
  check(`control: ${label}`, right && n1 === n0 && c1 === c0,
    `${r.status} ${r.body.code}${field ? `/${r.body.field}` : ''}${right ? '' : ` — wanted ${status} ${code}${field ? `/${field}` : ''}: ${r.body.error}`}; tx ${n1 - n0}; rows ${c1 - c0}`);
}

const ser = (s) => ({ ...s, allowance: s.allowance.toString(), salt: s.salt.toString() });
const salt = () => BigInt(keccak256(toHex(`${Date.now()}-${Math.random()}`)));
async function build(owner) {
  const pol = await (await fetch(`${BASE}/api/permissions`)).json();
  const account = await deriveSmartAccount(pub, owner, pol.manager);
  const start = Math.floor(Date.now() / 1000);
  const s = toStruct({ account, spender: pol.router, token: pol.usdc, allowance: pol.allowance, period: pol.periodSeconds,
    start, end: start + pol.durationSeconds, salt: salt(), extraData: pol.extraData });
  const hash = await pub.readContract({ address: pol.manager, abi: mgr, functionName: 'getHash', args: [s] });
  return { pol, account, s, hash };
}
const typed = (signer, account, hash, version = '1') => {
  const td = smartWalletTypedData(account, 84532, hash);
  return signer.signTypedData({ ...td, domain: { ...td.domain, version } });
};
const usdcOf = (a, o = {}) => pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a], ...o });

const baseline = {
  permissions: await permCount(),
  charges: (await query('SELECT count(*)::int c FROM charges')).rows[0].c,
  onchain_events: (await query('SELECT count(*)::int c FROM onchain_events')).rows[0].c,
  incoming_transfers: (await query('SELECT count(*)::int c FROM incoming_transfers')).rows[0].c,
  expected_payments: (await query('SELECT count(*)::int c FROM expected_payments')).rows[0].c,
  customers: (await query('SELECT count(*)::int c FROM customers')).rows[0].c,
};

try {
  console.log('=== setup ===');
  const up = await fetch(`${BASE}/api/permissions`).then((r) => r.ok).catch(() => false);
  check('the dev server is serving the registration policy', up);
  if (!up) throw new Error(`no server at ${BASE}`);

  const aKey = generatePrivateKey();
  const A = privateKeyToAccount(aKey);                       // the customer's key
  appendFileSync(KEY_LOG, `${new Date().toISOString()} ${A.address} ${aKey}\n`, { mode: 0o600 });
  const S = privateKeyToAccount(generatePrivateKey());      // a key that owns nothing
  const X = await build(A.address);
  console.log(`  customer EOA ${A.address}\n  smart account ${X.account}\n  permission ${X.hash}`);
  const code0 = await pub.getCode({ address: X.account });
  check('the smart account does not exist before the customer signs', !code0 || code0 === '0x');
  // Gas for the customer's OWN later transactions (revoke, withdraw). Registration itself costs them nothing.
  ev.gasForCustomer = await execW.sendTransaction({ to: A.address, value: parseEther('0.00005') }); await wait(ev.gasForCustomer);
  const good = { path: 'eoa_owned', signerEoa: A.address, permission: ser(X.s), permissionHash: X.hash, signature: await typed(A, X.account, X.hash) };

  console.log('\n=== signature controls — each refused, no transaction, no row ===');
  await refused('wrong domain version', { ...good, signature: await typed(A, X.account, X.hash, '2') }, 400, 'wrong_domain');
  await refused('personal_sign instead of typed data', { ...good, signature: await A.signMessage({ message: { raw: X.hash } }) }, 400, 'personal_sign');
  await refused('a signature over the unwrapped permission hash', { ...good, signature: await A.sign({ hash: X.hash }) }, 400, 'unwrapped_hash');
  await refused('correct typed data from a key that does not own the account', { ...good, signature: await typed(S, X.account, X.hash) }, 400, 'not_owner');
  await refused('another EOA claiming this smart account', { ...good, signerEoa: S.address }, 400, 'account_mismatch');
  await refused('the page showed a different fingerprint than the terms submitted', { ...good, permissionHash: keccak256('0x01') }, 400, 'hash_mismatch');

  console.log('\n=== policy controls — every term pinned to configuration ===');
  const pol = X.pol;
  for (const [field, ov] of [
    ['allowance', { allowance: (BigInt(pol.allowance) + 1n).toString() }],
    ['period', { period: pol.periodSeconds * 2 }],
    ['end', { end: X.s.end + 86400 }],
    ['start', { start: X.s.start - 86400, end: X.s.end - 86400 }],
    ['spender', { spender: exec.address }],
    ['token', { token: exec.address }],
  ]) await refused(`policy pins ${field}`, { ...good, permission: { ...ser(X.s), ...ov } }, 400, 'policy', field);

  console.log('\n=== owner-code control ===');
  const Y = await build(FUND_WALLET);
  await refused('a contract as the owner (the Phase 1 smart wallet)',
    { path: 'eoa_owned', signerEoa: FUND_WALLET, permission: ser(Y.s), permissionHash: Y.hash, signature: await typed(A, Y.account, Y.hash) }, 409, 'contract_owner');

  console.log('\n=== registration: one signature, deploy + owners + approve in one transaction ===');
  const n0 = await nonceOf();
  const reg = await post('/api/permissions', good);
  check('registration succeeds', reg.status === 200, reg.body.error ?? reg.body.approveTx);
  ev.register = reg.body.approveTx; made.txs.push(ev.register);
  check('it cost exactly one executor transaction', (await nonceOf()) === n0 + 1);
  const regR = await pub.waitForTransactionReceipt({ hash: ev.register });
  const code1 = await at(regR, (o) => pub.getCode({ address: X.account, ...o }));
  check('the smart account now exists, created inside that transaction', !!code1 && code1 !== '0x' && reg.body.accountCreatedByThisTx === true);
  check('the manager is an owner from creation — no addOwnerAddress step',
    await at(regR, (o) => pub.readContract({ address: X.account, abi: smartWalletAbi, functionName: 'isOwnerAddress', args: [cfg.manager], ...o })));
  check('the customer EOA is an owner',
    await at(regR, (o) => pub.readContract({ address: X.account, abi: smartWalletAbi, functionName: 'isOwnerAddress', args: [A.address], ...o })));
  check('the permission is approved on-chain',
    await at(regR, (o) => pub.readContract({ address: cfg.manager, abi: mgr, functionName: 'isApproved', args: [X.s], ...o })));
  const row = (await query('SELECT * FROM permissions WHERE permission_hash = $1', [X.hash])).rows[0];
  made.permissionIds.push(row?.id);
  check('stored as eoa_owned, with its signer and a hashed client id (never the IP)',
    row?.signing_path === 'eoa_owned' && row?.signer_eoa === A.address && /^[0-9a-f]{64}$/.test(row?.registration_ip_hash ?? ''));

  {
    const [n, c] = [await nonceOf(), await permCount()];
    const again = await post('/api/permissions', good);
    check('resubmitting the same permission is idempotent — no transaction, no new row',
      again.status === 200 && again.body.alreadyRegistered === true && (await nonceOf()) === n && (await permCount()) === c);
  }
  const X2 = await build(A.address);
  await refused('rate limit: a second permission from the same signer inside the cooldown',
    { ...good, permission: ser(X2.s), permissionHash: X2.hash, signature: await typed(A, X2.account, X2.hash) }, 429, 'rate_limited');

  {
    const r = await post('/api/permissions/revoke', { permissionHash: X.hash, txHash: ev.register });
    const still = (await query('SELECT revoked_at FROM permissions WHERE id = $1', [row.id])).rows[0].revoked_at;
    check('control: the revoke record refuses a transaction that did not revoke', r.status === 400 && r.body.code === 'not_the_revoking_tx' && still === null, r.body.code);
  }

  console.log('\n=== funding and the first charge ===');
  ev.fund = await funderW.writeContract({ address: FUND_WALLET, abi: smartWalletAbi, functionName: 'execute',
    args: [cfg.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [X.account, BigInt(pol.allowance)] })] });
  const fundR = await wait(ev.fund);
  const funded = await at(fundR, (o) => usdcOf(X.account, o));
  check('the smart account holds one period\'s allowance', funded === BigInt(pol.allowance), `${funded}`);

  // Through the documented CLI command, not a hand-written insert: it is the path a merchant
  // uses, and the one migration 003 had silently broken.
  const cli = (...a) => JSON.parse(execFileSync('node', ['--env-file=.env', 'apps/cli/src/index.js', ...a], { encoding: 'utf8' }));
  const enq = cli('enqueue', '--permission', String(row.id), '--amount', '1000000');
  const chargeId = enq.charge?.id;
  made.chargeIds.push(chargeId);
  if (enq.expectedPaymentId) made.expectedPaymentIds.push(enq.expectedPaymentId);
  if (enq.createdCustomer) made.customerIds.push(enq.customerId);
  const epRow = (await query(`SELECT e.fulfilment::text AS f, e.permission_id, e.state::text AS state FROM charges c
                               JOIN expected_payments e ON e.id = c.expected_payment_id WHERE c.id = $1`, [chargeId])).rows[0];
  check('`cli enqueue` creates the charge and the pull obligation it fulfils',
    enq.created === true && epRow?.f === 'pull' && String(epRow?.permission_id) === String(row.id), `obligation #${enq.expectedPaymentId} ${epRow?.state}`);
  const epCount = async () => (await query('SELECT count(*)::int c FROM expected_payments')).rows[0].c;
  const e0 = await epCount();
  const again = cli('enqueue', '--permission', String(row.id), '--amount', '1000000');
  check('control: enqueueing the same period again creates nothing',
    again.created === false && String(again.charge?.id) === String(chargeId) && (await epCount()) === e0);
  const treasury0 = await at(fundR, (o) => usdcOf(cfg.treasury, o));
  // Exactly the worker's tick order: recover anything in flight, index, confirm, then new work.
  // (A charge whose attempt was superseded goes back to the queue and is attempted again.)
  let state = null, attempts = 0;
  for (let i = 0; i < 60; i++) {
    await recoverOpenAttempts(); await indexEvents(); await confirmCharges();
    state = (await query('SELECT state::text s FROM charges WHERE id = $1', [chargeId])).rows[0].s;
    if (state === 'confirmed') break;
    if (['pending', 'failed_retryable', 'failed_deferred'].includes(state)) {
      const claimed = await claimCharge(chargeId);
      if (claimed) { attempts++; const out = await attemptCharge(claimed); console.log(`  attempt ${attempts}: ${JSON.stringify(out).slice(0, 120)}`); }
    }
    await sleep(3000);
  }
  ev.charge = (await query('SELECT confirmed_tx_hash FROM charges WHERE id = $1', [chargeId])).rows[0]?.confirmed_tx_hash;
  check('the charge is confirmed — by the reconciler, from both on-chain events', state === 'confirmed', `${state}, ${attempts} attempt(s)`);
  const chargeR = ev.charge ? await pub.waitForTransactionReceipt({ hash: ev.charge }) : null;
  check('the treasury received exactly 1.000000 USDC', !!chargeR && (await at(chargeR, (o) => usdcOf(cfg.treasury, o))) - treasury0 === 1_000_000n);
  check('the router holds nothing afterwards', !!chargeR && (await at(chargeR, (o) => usdcOf(cfg.router, o))) === 0n);
  await settleFromConfirmedCharges();
  const ob = (await query('SELECT state::text s, amount_settled FROM expected_payments WHERE id = $1', [enq.expectedPaymentId])).rows[0];
  check('the obligation behind it is now paid — settled from the reconciled charge',
    ob?.s === 'paid' && String(ob?.amount_settled) === '1000000', `${ob?.s} / ${ob?.amount_settled}`);

  console.log('\n=== the owner upgrades to EIP-7702 AFTER approval ===');
  const impl = await pub.readContract({ address: SMART_WALLET_FACTORY, abi: parseAbi(['function implementation() view returns (address)']), functionName: 'implementation' });
  const auth = await A.signAuthorization({ address: impl, contractAddress: impl, chainId: 84532,
    nonce: await pub.getTransactionCount({ address: A.address }) });
  ev.upgrade7702 = await execW.sendTransaction({ authorizationList: [auth], to: exec.address, value: 0n });
  const upR = await wait(ev.upgrade7702);
  const k = classifyOwnerCode(await at(upR, (o) => pub.getCode({ address: A.address, ...o })));
  check('the customer EOA now carries a 7702 designator', k.kind === 'eip7702' && k.delegate === getAddress(impl), `${k.kind} -> ${k.delegate}`);
  // Simulated AT the upgrade's block, so the node provably sees the 7702 code while it evaluates the spend.
  const spendsStill = await at(upR, (o) => pub.simulateContract({ address: cfg.router, abi: spendRouterAbi, functionName: 'spendAndRoute',
    args: [X.s, 1_000_000n], account: exec, ...o }).then(() => true).catch((e) => { if (/block|header/i.test(e.message)) throw e; return e.shortMessage; }));
  check('a spend against the existing permission still validates — spends check the stored approval, not the signature', spendsStill === true, String(spendsStill));
  const X3 = await build(A.address);
  await refused('an owner delegating to any other contract (here the CoinbaseSmartWallet implementation) is refused before its signature is considered',
    { path: 'eoa_owned', signerEoa: A.address, permission: ser(X3.s), permissionHash: X3.hash, signature: await typed(A, X3.account, X3.hash) }, 409, 'eip7702');

  console.log('\n=== the customer revokes, from their own key ===');
  const Aw = createWalletClient({ account: A, chain: baseSepolia, transport: http(cfg.rpcUrl) });
  ev.revoke = await Aw.writeContract({ address: X.account, abi: smartWalletAbi, functionName: 'execute',
    args: [cfg.manager, 0n, encodeFunctionData({ abi: mgr, functionName: 'revoke', args: [X.s] })] });
  const rvR = await wait(ev.revoke);
  check('revoked on-chain by the customer\'s own transaction',
    await at(rvR, (o) => pub.readContract({ address: cfg.manager, abi: mgr, functionName: 'isRevoked', args: [X.s], ...o })));
  const rv = await post('/api/permissions/revoke', { permissionHash: X.hash, txHash: ev.revoke });
  const rrow = (await query('SELECT revoked_at, revoked_tx_hash FROM permissions WHERE id = $1', [row.id])).rows[0];
  check('the revocation is recorded — only after the chain confirmed it', rv.status === 200 && !!rrow.revoked_at && rrow.revoked_tx_hash === ev.revoke, rv.body.code ?? '');
  const v = await classify({ client: pub, permission: X.s, amount: 1_000_000n, manager: cfg.manager, router: cfg.router });
  check('the charger\'s pre-flight now classifies it REVOKED — terminal, before any gas', !v.ok && v.mode === 'REVOKED', v.mode);
  const after = await at(rvR, (o) => pub.simulateContract({ address: cfg.router, abi: spendRouterAbi, functionName: 'spendAndRoute', args: [X.s, 1_000_000n], account: exec, ...o })
    .then(() => true).catch((e) => { if (/block|header/i.test(e.message)) throw e; return false; }));
  check('negative control: the same spend that validated before now reverts', after === false);

  // The customer still controls what is left: withdraw it (and recycle the drill's test USDC).
  const left = await at(rvR, (o) => usdcOf(X.account, o));
  ev.withdraw = await Aw.writeContract({ address: X.account, abi: smartWalletAbi, functionName: 'execute',
    args: [cfg.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [FUND_WALLET, left] })] });
  const wdR = await wait(ev.withdraw);
  check('the owner can still move their own funds out after revoking', (await at(wdR, (o) => usdcOf(X.account, o))) === 0n, `${left} withdrawn`);
  console.log('\n=== an owner MetaMask has upgraded: its verified delegator is accepted, and only it ===');
  // A fresh key delegated to MetaMask's EIP7702StatelessDeleGator -- the state MetaMask leaves a customer in
  // after a revoke. The one delegate TRUSTED_7702_DELEGATES admits, pinned by code hash.
  const MM = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B';
  const mKey = generatePrivateKey(); const M = privateKeyToAccount(mKey);
  appendFileSync(KEY_LOG, `${new Date().toISOString()} metamask-delegated ${M.address} ${mKey}\n`, { mode: 0o600 });
  const mAuth = await M.signAuthorization({ address: MM, contractAddress: MM, chainId: 84532, nonce: 0 });
  ev.metamaskDelegation = await execW.sendTransaction({ authorizationList: [mAuth], to: exec.address, value: 0n });
  const mR = await wait(ev.metamaskDelegation);
  const mk = await at(mR, (o) => checkOwner(pub, M.address, o));
  check('the owner delegates to MetaMask\'s verified delegator, and checkOwner accepts it', mk.kind === 'eip7702' && mk.accepted === true, `${mk.kind} -> ${mk.delegate}`);
  const XM = await build(M.address);
  const goodM = { path: 'eoa_owned', signerEoa: M.address, permission: ser(XM.s), permissionHash: XM.hash, signature: await typed(M, XM.account, XM.hash) };
  await refused('a different key\'s signature for a MetaMask-delegated account is refused', { ...goodM, signature: await typed(S, XM.account, XM.hash) }, 400, 'not_owner');
  const nM = await nonceOf();
  const regM = await post('/api/permissions', goodM);
  check('a MetaMask-delegated owner can register — one signature, account created', regM.status === 200 && regM.body.accountCreatedByThisTx === true, regM.body.error ?? regM.body.approveTx);
  ev.registerMetaMask7702 = regM.body.approveTx; made.txs.push(ev.registerMetaMask7702);
  const rowM = (await query('SELECT id FROM permissions WHERE permission_hash = $1', [XM.hash])).rows[0]; made.permissionIds.push(rowM?.id);
  check('it cost exactly one executor transaction', (await nonceOf()) === nM + 1);
  const regMR = await pub.waitForTransactionReceipt({ hash: ev.registerMetaMask7702 });
  check('the permission is approved on-chain', await at(regMR, (o) => pub.readContract({ address: cfg.manager, abi: mgr, functionName: 'isApproved', args: [XM.s], ...o })));
  // The pin. The same trusted address with any other code must be refused.
  const tampered = { [MM.toLowerCase()]: { ...TRUSTED_7702_DELEGATES[MM.toLowerCase()], codeHash: '0x' + '00'.repeat(32) } };
  const pinned = await at(regMR, (o) => checkOwner(pub, M.address, { ...o, trusted: tampered }));
  check('control: had the delegator\'s code hashed differently from the reviewed version, the owner would be refused', !pinned.accepted && pinned.reason === 'delegate_code_changed', pinned.reason);
} catch (e) {
  fail++; console.log(`  [FAIL] drill aborted: ${e.shortMessage ?? e.message}`);
} finally {
  console.log('\n=== teardown ===');
  // Index the charge's router -> treasury transfer now, so it is removed with the rest rather than
  // appearing later as an internal transfer with no charge behind it.
  try { for (let i = 0; i < 25; i++) { const r = await indexIncomingTransfers(); if (!r.indexed && !r.scanned) break; } } catch { /* best effort */ }
  const P = made.permissionIds.filter(Boolean), C = made.chargeIds.filter(Boolean);
  const attemptTxs = C.length ? (await query('SELECT tx_hash FROM charge_attempts WHERE charge_id = ANY($1::bigint[]) AND tx_hash IS NOT NULL', [C])).rows.map((r) => r.tx_hash) : [];
  const H = [...new Set([...made.txs, ev.charge, ...attemptTxs].filter(Boolean))];
  const E = made.expectedPaymentIds.filter(Boolean), K = made.customerIds.filter(Boolean);
  const evWhere = `charge_id = ANY($1::bigint[]) OR expected_payment_id = ANY($3::bigint[])
                   OR transfer_id IN (SELECT id FROM incoming_transfers WHERE tx_hash = ANY($2::text[]))`;
  await query(`DELETE FROM deliveries WHERE event_id IN (SELECT id FROM events WHERE ${evWhere})`, [C, H, E]);
  await query(`DELETE FROM events WHERE ${evWhere}`, [C, H, E]);
  await query(`DELETE FROM audit_log WHERE permission_id = ANY($1::bigint[]) OR charge_id = ANY($2::bigint[])`, [P, C]);
  await query(`DELETE FROM charge_attempts WHERE charge_id = ANY($1::bigint[])`, [C]);
  await query(`DELETE FROM charges WHERE id = ANY($1::bigint[])`, [C]);
  await query(`DELETE FROM expected_payments WHERE id = ANY($1::bigint[])`, [E]);
  await query(`DELETE FROM customer_addresses WHERE customer_id = ANY($1::bigint[])`, [K]);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [K]);
  await query(`DELETE FROM incoming_transfers WHERE tx_hash = ANY($1::text[])`, [H]);
  await query(`DELETE FROM onchain_events WHERE tx_hash = ANY($1::text[])`, [H]);
  await query(`DELETE FROM permissions WHERE id = ANY($1::bigint[])`, [P]);
  // Tables only the drill writes to must return to baseline. The two indexer tables are NOT
  // compared by count: advancing the indexer legitimately stores other people's events on the
  // shared manager. For those, what must be gone is anything from the drill's own transactions.
  const now = {
    permissions: await permCount(),
    charges: (await query('SELECT count(*)::int c FROM charges')).rows[0].c,
    expected_payments: (await query('SELECT count(*)::int c FROM expected_payments')).rows[0].c,
    customers: (await query('SELECT count(*)::int c FROM customers')).rows[0].c,
  };
  const mine = (await query(`SELECT (SELECT count(*) FROM onchain_events WHERE tx_hash = ANY($1::text[]))
                                  + (SELECT count(*) FROM incoming_transfers WHERE tx_hash = ANY($1::text[])) AS c`, [H])).rows[0].c;
  const want = { permissions: baseline.permissions, charges: baseline.charges, expected_payments: baseline.expected_payments, customers: baseline.customers };
  check('the drill left no rows behind', JSON.stringify(now) === JSON.stringify(want) && Number(mine) === 0,
    `${JSON.stringify(now)}; indexer rows from drill transactions: ${mine}`);

  console.log('\n=== evidence (Base Sepolia) ===');
  for (const [k, h] of Object.entries(ev)) console.log(`  ${k.padEnd(15)} ${h}`);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await close();
  process.exit(fail ? 1 : 0);
}
