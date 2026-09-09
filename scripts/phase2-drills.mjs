/**
 * Drive every matching outcome end to end against real Base Sepolia transfers,
 * and prove each assertion is sensitive with a negative control.
 *
 * A check that passes because it never ran is worse than no check. So for each
 * case the drill also flips the one precondition that should change the verdict
 * and asserts it actually changes -- inside a transaction that is rolled back,
 * so the control cannot pollute the data it is testing.
 */
import { createWalletClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { publicClient, config, erc20Abi } from '@retainer/chain';
import { query, pool, close } from '@retainer/db';
import { indexIncomingTransfers } from '../apps/worker/src/watcher.js';
import { matchPendingTransfers, classifyTransfer } from '../apps/worker/src/matcher.js';

const cfg = config();
const pub = publicClient();
const USDC = getAddress(cfg.usdc);
const TREASURY = getAddress(process.env.MERCHANT_TREASURY_ADDRESS);
const A = privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY);
const B = privateKeyToAccount(process.env.TEST_SENDER_B_PRIVATE_KEY);
const wallet = (acct) => createWalletClient({ account: acct, chain: baseSepolia, transport: http(cfg.rpcUrl) });

const rows = async (sql, p = []) => (await query(sql, p)).rows;
let pass = 0, fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

async function send(from, amount, note) {
  const h = await wallet(from).writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [TREASURY, amount] });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') throw new Error(`transfer reverted: ${h}`);
  console.log(`     sent ${(Number(amount) / 1e6).toFixed(6)} USDC from ${from.address.slice(0, 10)}… (${note})  ${h}`);
  return h;
}

/** Re-run the classifier with a precondition mutated, then roll back. */
async function control(label, transferId, mutate, expect) {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    await mutate(c);
    const t = (await c.query('SELECT * FROM incoming_transfers WHERE id = $1', [transferId])).rows[0];
    const v = await classifyTransfer(c, t);
    const ok = v.reason === expect || v.state === expect;
    check(`   negative control: ${label}`, ok, `verdict became ${v.state}/${v.reason}, expected ${expect}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

/**
 * Provision both senders so the drill is genuinely re-runnable.
 *
 * The faucet balance lives in the scripted smart wallet, so when SENDER_A runs
 * dry we draw from it by calling execute() as its owner, then top SENDER_B up
 * from SENDER_A. Without this the drill silently depends on however much was
 * left over from the last run.
 */
async function ensureFunds() {
  const { encodeFunctionData, parseAbi } = await import('viem');
  const walletAbi = parseAbi(['function execute(address target, uint256 value, bytes data)']);
  const bal = (a) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
  const SMART = getAddress(process.env.TEST_SMART_WALLET);

  const needB = 1_400_000n;   // 140k + 770k + 210k, plus headroom for the run nonce
  const needA = 500_000n;     // 110k + 120k + 90k, plus headroom

  const shortB = (await bal(B.address)) >= needB ? 0n : needB - (await bal(B.address));
  const needTotalA = needA + shortB;

  if ((await bal(A.address)) < needTotalA) {
    const draw = needTotalA - (await bal(A.address)) + 200_000n;
    const inWallet = await bal(SMART);
    if (inWallet < draw) throw new Error(`smart wallet has ${inWallet}, drill needs ${draw} more for SENDER_A`);
    const h = await wallet(A).writeContract({
      address: SMART, abi: walletAbi, functionName: 'execute',
      args: [USDC, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [A.address, draw] })],
    });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  drew ${draw} from the smart wallet to SENDER_A (${h})`);
  }

  if (shortB > 0n) {
    const h = await wallet(A).writeContract({ address: USDC, abi: erc20Abi, functionName: 'transfer', args: [B.address, shortB + 100_000n] });
    await pub.waitForTransactionReceipt({ hash: h });
    console.log(`  topped SENDER_B up by ${shortB + 100_000n} (${h})`);
  }
}

const findByTx = async (h) => (await rows('SELECT * FROM incoming_transfers WHERE lower(tx_hash) = lower($1)', [h]))[0];

// ---------------------------------------------------------------- setup
console.log('=== setup ===');
// Repeatability: a previous run leaves SENDER_B linked and its obligations open,
// which would silently change what later cases are even testing.
await query('DELETE FROM customer_addresses WHERE chain_id=$1 AND lower(address)=lower($2)', [cfg.chainId, B.address]);
const retired = await rows(`UPDATE expected_payments SET state='void'
   WHERE reference LIKE 'drill:%' AND state NOT IN ('paid','void') RETURNING id`);
if (retired.length) console.log(`  retired ${retired.length} obligation(s) from a previous run`);
const stale = await rows(`UPDATE incoming_transfers SET match_state='ignored', resolved_by='drill:stale-from-aborted-run', resolved_at=now()
   WHERE match_state='pending' RETURNING id`);
if (stale.length) console.log(`  ignored ${stale.length} transfer(s) left pending by an aborted run`);
await ensureFunds();
const drillCustomer = (await rows(
  `INSERT INTO customers (label) VALUES ('Drill customer (SENDER_A)') RETURNING id`))[0].id;
await query(
  `INSERT INTO customer_addresses (customer_id, chain_id, address, note) VALUES ($1,$2,$3,'drill: known sender')
   ON CONFLICT (chain_id, address) DO UPDATE SET customer_id = $1`,
  [drillCustomer, cfg.chainId, A.address]);
const emptyCustomer = (await rows(
  `INSERT INTO customers (label) VALUES ('Drill customer with nothing open (SENDER_B)') RETURNING id`))[0].id;
console.log(`  customer ${drillCustomer} <- SENDER_A linked | customer ${emptyCustomer} created (no obligations)`);

const mkEP = async (customerId, amount, ref) => (await rows(
  `INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, state, fulfilment, reference)
   VALUES ($1,$2,$3,$4, now(), 'due', 'watch', $5) RETURNING id`,
  [customerId, String(amount), USDC, cfg.chainId, ref]))[0].id;

// Offset every amount by a per-run nonce. Without this, a transfer left
// 'pending' by an aborted run is classified first (lower block) and consumes
// this run's obligation, so the case under test fails for a reason that has
// nothing to do with the matcher.
const off = BigInt((Date.now() % 800) + 101);
const AMT = { exact: 110000n + off, ambig: 120000n + off, short: 90000n + off,
              mismatch: 130000n + off, unknown: 140000n + off, unattributed: 770000n + off, noOpen: 210000n + off };
console.log(`  run nonce +${off} applied to every drill amount`);

const ep1 = await mkEP(drillCustomer, AMT.exact, 'drill:exact');
const ep2a = await mkEP(drillCustomer, AMT.ambig, 'drill:ambiguous-a');
const ep2b = await mkEP(drillCustomer, AMT.ambig, 'drill:ambiguous-b');
const ep3 = await mkEP(drillCustomer, AMT.mismatch, 'drill:mismatch');
const ep4 = await mkEP(drillCustomer, AMT.unknown, 'drill:unknown-sender');
console.log(`  expected payments: exact=${ep1} ambiguous=${ep2a},${ep2b} mismatch=${ep3} unknownSender=${ep4}`);

// ------------------------------------------------------- case 0: internal
console.log('\n=== case 0: router_fulfilment (our own router paying the treasury) ===');
await indexIncomingTransfers({ fromBlock: 46565000 });
await matchPendingTransfers();
const internal = await rows(`SELECT count(*)::int c FROM incoming_transfers WHERE match_state = 'internal' AND match_reason = 'router_fulfilment'`);
check('six historic router transfers classified internal, never matched', internal[0].c === 6, `${internal[0].c} internal`);
const leaked = await rows(
  `SELECT count(*)::int c FROM payment_matches pm JOIN incoming_transfers t ON t.id = pm.transfer_id WHERE t.match_state = 'internal'`);
check('no internal transfer produced a match (double-count guard)', leaked[0].c === 0, `${leaked[0].c} matches`);
const anyInternal = (await rows(`SELECT id FROM incoming_transfers WHERE match_state='internal' LIMIT 1`))[0];
await control('a non-router sender is no longer internal', anyInternal.id,
  (c) => c.query(`UPDATE incoming_transfers SET from_address = $2 WHERE id = $1`, [anyInternal.id, B.address]),
  'needs_review');

// ------------------------------------------------------- on-chain transfers
console.log('\n=== sending real transfers ===');
const txExact = await send(A, AMT.exact, 'case 1: exact, known sender');
const txAmbig = await send(A, AMT.ambig, 'case 2: exact but two candidates');
const txShort = await send(A, AMT.short, 'case 3: known sender, short of 130000');
const txUnknown = await send(B, AMT.unknown, 'case 4: exact, sender not linked');
const txUnattrib = await send(B, AMT.unattributed, 'case 6: nothing matches');

console.log('\n  waiting for 3 confirmations…');
const target = await pub.getBlockNumber();
while ((await pub.getBlockNumber()) < target + 4n) await new Promise((r) => setTimeout(r, 2000));

const idx = await indexIncomingTransfers();
console.log(`  indexed ${idx.indexed} new transfer(s) from block ${idx.from} to ${idx.to}`);
const matched = await matchPendingTransfers();
console.log(`  classified ${matched.length} transfer(s)`);

// ------------------------------------------------------------- the cases
console.log('\n=== case 1: exact_known_sender -> auto_matched (the ONLY automatic path) ===');
const t1 = await findByTx(txExact);
check('auto_matched with reason exact_known_sender', t1.match_state === 'auto_matched' && t1.match_reason === 'exact_known_sender', `${t1.match_state}/${t1.match_reason}`);
const m1 = await rows('SELECT * FROM payment_matches WHERE transfer_id = $1', [t1.id]);
check('applied to the right expected payment, in full', m1.length === 1 && String(m1[0].expected_payment_id) === String(ep1) && m1[0].amount_applied === String(AMT.exact));
const ep1row = (await rows('SELECT state::text s, amount_settled FROM expected_payments WHERE id=$1', [ep1]))[0];
check('expected payment is now paid and settled', ep1row.s === 'paid' && ep1row.amount_settled === String(AMT.exact), `${ep1row.s} ${ep1row.amount_settled}`);
// Reopen the obligation this transfer just settled, so the ONLY thing the control
// changes is whether the sender is known. Without that, the verdict moves for two
// reasons at once and the control proves nothing about sender knowledge.
await control('unlink the sender and it must stop auto-matching', t1.id, async (c) => {
  await c.query('DELETE FROM payment_matches WHERE transfer_id = $1', [t1.id]);
  await c.query(`UPDATE expected_payments SET state='due', amount_settled=0 WHERE id=$1`, [ep1]);
  await c.query('DELETE FROM customer_addresses WHERE chain_id=$1 AND lower(address)=lower($2)', [cfg.chainId, A.address]);
}, 'unknown_sender');

console.log('\n=== case 2: ambiguous_multiple_exact -> review, never a guess ===');
const t2 = await findByTx(txAmbig);
check('needs_review with reason ambiguous_multiple_exact', t2.match_state === 'needs_review' && t2.match_reason === 'ambiguous_multiple_exact', `${t2.match_state}/${t2.match_reason}`);
check('both tied candidates shown as evidence', (t2.candidates ?? []).length === 2, `${(t2.candidates ?? []).length} candidates`);
check('nothing was applied', (await rows('SELECT count(*)::int c FROM payment_matches WHERE transfer_id=$1', [t2.id]))[0].c === 0);
await control('void one of the two and the tie resolves to an auto-match', t2.id,
  (c) => c.query(`UPDATE expected_payments SET state='void' WHERE id=$1`, [ep2b]),
  'exact_known_sender');

console.log('\n=== case 3: amount_mismatch -> review (partial or negotiated discount: undecidable) ===');
const t3 = await findByTx(txShort);
check('needs_review with reason amount_mismatch', t3.match_state === 'needs_review' && t3.match_reason === 'amount_mismatch', `${t3.match_state}/${t3.match_reason}`);
const cand3 = (t3.candidates ?? []).find((x) => String(x.expected_payment_id) === String(ep3));
check('the shortfall is shown, signed', cand3 && cand3.delta === '-40000', `delta ${cand3?.delta}`);
await control('make the expected amount equal the transfer and it auto-matches', t3.id,
  (c) => c.query('UPDATE expected_payments SET amount_expected = $2 WHERE id=$1', [ep3, String(AMT.short)]),
  'exact_known_sender');

console.log('\n=== case 4: unknown_sender -> review ===');
const t4 = await findByTx(txUnknown);
check('needs_review with reason unknown_sender', t4.match_state === 'needs_review' && t4.match_reason === 'unknown_sender', `${t4.match_state}/${t4.match_reason}`);
check('the amount-matching candidate is offered', (t4.candidates ?? []).some((x) => String(x.expected_payment_id) === String(ep4)));
await control('link the sender to that customer and it auto-matches', t4.id,
  (c) => c.query(`INSERT INTO customer_addresses (customer_id, chain_id, address) VALUES ($1,$2,$3)`, [drillCustomer, cfg.chainId, B.address]),
  'exact_known_sender');

console.log('\n=== case 6: unattributed -> review, surfaced not discarded ===');
const t6 = await findByTx(txUnattrib);
check('needs_review with reason unattributed', t6.match_state === 'needs_review' && t6.match_reason === 'unattributed', `${t6.match_state}/${t6.match_reason}`);
check('surfaced rather than dropped', t6.match_state !== 'ignored' && t6.id != null);
await control('link the sender and give it a matching obligation -> auto-match', t6.id, async (c) => {
  await c.query(`INSERT INTO customer_addresses (customer_id, chain_id, address) VALUES ($1,$2,$3)`, [drillCustomer, cfg.chainId, B.address]);
  await c.query(`INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, state, fulfilment, reference)
                 VALUES ($1,$4,$2,$3, now(), 'due','watch','control:unattributed')`, [drillCustomer, USDC, cfg.chainId, String(AMT.unattributed)]);
}, 'exact_known_sender');

console.log('\n=== case 5: no_open_payment_for_sender -> review (we know who, not what for) ===');
await query(`INSERT INTO customer_addresses (customer_id, chain_id, address, note) VALUES ($1,$2,$3,'drill: known sender, nothing owed')
             ON CONFLICT (chain_id, address) DO UPDATE SET customer_id = $1`, [emptyCustomer, cfg.chainId, B.address]);
const txNoOpen = await send(B, AMT.noOpen, 'case 5: known sender, nothing open');
const t5target = await pub.getBlockNumber();
while ((await pub.getBlockNumber()) < t5target + 4n) await new Promise((r) => setTimeout(r, 2000));
await indexIncomingTransfers();
await matchPendingTransfers();
const t5 = await findByTx(txNoOpen);
check('needs_review with reason no_open_payment_for_sender', t5.match_state === 'needs_review' && t5.match_reason === 'no_open_payment_for_sender', `${t5.match_state}/${t5.match_reason}`);
check('not mislabelled as unattributed — the sender IS known', t5.match_reason !== 'unattributed');
await control('give that customer a matching obligation -> auto-match', t5.id,
  (c) => c.query(`INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, state, fulfilment, reference)
                  VALUES ($1,$4,$2,$3, now(), 'due','watch','control:no-open')`, [emptyCustomer, USDC, cfg.chainId, String(AMT.noOpen)]),
  'exact_known_sender');

// ------------------------------------------------------------- invariants
console.log('\n=== invariants ===');
const autos = await rows(`SELECT count(*)::int c FROM incoming_transfers WHERE match_state='auto_matched' AND match_reason <> 'exact_known_sender'`);
check('exact_known_sender is the sole writer of auto_matched', autos[0].c === 0, `${autos[0].c} exceptions`);
const over = await rows(`SELECT t.id FROM incoming_transfers t JOIN payment_matches pm ON pm.transfer_id=t.id
                         GROUP BY t.id, t.value HAVING SUM(pm.amount_applied) > t.value`);
check('no transfer has more applied than its value', over.length === 0, `${over.length} over-applied`);
const settledUnconfirmed = await rows(`SELECT count(*)::int c FROM expected_payments ep
  WHERE ep.amount_settled > 0 AND NOT EXISTS (SELECT 1 FROM payment_matches pm WHERE pm.expected_payment_id=ep.id)
    AND NOT EXISTS (SELECT 1 FROM charges ch WHERE ch.expected_payment_id=ep.id AND ch.state='confirmed')`);
check('nothing settled without a confirmed charge or a match', settledUnconfirmed[0].c === 0, `${settledUnconfirmed[0].c} unbacked`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await close();
process.exit(fail ? 1 : 0);
