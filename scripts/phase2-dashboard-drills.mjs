/**
 * Drive the five review actions through the real HTTP path -- the same
 * multipart POST a browser with JavaScript disabled would send -- and prove
 * each assertion is sensitive with a negative control.
 *
 * These are the only mutations anywhere in the dashboard, so they are the only
 * part of the web layer that can corrupt data. Testing resolveReview directly
 * (phase2-drills.mjs) does not prove the server actions are wired to it, that
 * the form fields carry the values the action reads, or that a rejected action
 * leaves the database untouched. This drill covers exactly that seam.
 *
 * Every fixture it creates is removed at the end, so running it does not add
 * rows to the dashboard.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@retainer/chain';
import { query, close } from '@retainer/db';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const REVIEW = `${BASE}/dashboard/review`;
const cfg = config();
const rows = async (s, p = []) => (await query(s, p)).rows;
const one = async (s, p = []) => (await rows(s, p))[0];
let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };

/* ---------------------------------------------------------------- wiring */

/**
 * Server action ids are content-hashed, so they cannot be hard-coded. Turbopack
 * leaves the generated actions-loader module in the dev output, which maps each
 * exported action name to its id.
 */
function actionIds(dir, acc = {}) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { actionIds(p, acc); continue; }
    if (!/\.(js|map)$/.test(e)) continue;
    for (const m of readFileSync(p, 'utf8').matchAll(/export ?\{ ?(\w+) as '([0-9a-f]{20,})' ?\}/g)) acc[m[1]] = m[2];
  }
  return acc;
}

/** One $ACTION_KEY from the live page; React expects the field to be present. */
async function actionKey() {
  const html = await (await fetch(REVIEW)).text();
  return html.match(/name="\$ACTION_KEY" value="([^"]+)"/)?.[1] ?? '';
}

/**
 * Post a server action exactly as a no-JS browser does: a multipart form to the
 * page URL, no Next-Action header, with the bound previous state ([null], from
 * useActionState) carried in $ACTION_<n>:1.
 */
async function post(id, key, fields) {
  const fd = new FormData();
  fd.set('$ACTION_REF_1', '');
  fd.set('$ACTION_1:0', JSON.stringify({ id, bound: '$@1' }));
  fd.set('$ACTION_1:1', '[null]');
  fd.set('$ACTION_KEY', key);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) fd.set(k, String(v));
  const res = await fetch(REVIEW, { method: 'POST', body: fd });
  return { status: res.status, body: await res.text() };
}

/* --------------------------------------------------------------- fixtures */

const RUN = Date.now();
const made = { customers: [], payments: [], transfers: [] };
let nonce = 0;

async function customer(label) {
  const c = await one(`INSERT INTO customers (label) VALUES ($1) RETURNING id`, [`${label} [drill ${RUN}]`]);
  made.customers.push(c.id);
  return c.id;
}

async function payment(customerId, amount) {
  const p = await one(
    `INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, state, fulfilment, reference)
     VALUES ($1,$2,$3,$4, now() - interval '1 day', 'due', 'watch', $5) RETURNING id`,
    [customerId, String(amount), cfg.usdc, cfg.chainId, `webdrill:${RUN}`]);
  made.payments.push(p.id);
  return p.id;
}

/**
 * A synthetic transfer row. The indexer that writes real ones is drilled
 * separately against live Base Sepolia transfers; what is under test here is
 * the action layer above it, so the row is inserted directly.
 */
async function transfer({ from, value, reason, candidates }) {
  nonce += 1;
  const t = await one(
    `INSERT INTO incoming_transfers
       (chain_id, token, tx_hash, log_index, block_number, block_hash, from_address, to_address, value, match_state, match_reason, candidates)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'needs_review',$10,$11::jsonb) RETURNING id`,
    [cfg.chainId, cfg.usdc,
     '0x' + (RUN * 1000 + nonce).toString(16).padStart(64, 'd'), nonce, 1,
     '0x' + 'bb'.repeat(32), from, process.env.MERCHANT_TREASURY_ADDRESS, String(value),
     reason, JSON.stringify(candidates ?? [])]);
  made.transfers.push(t.id);
  return t.id;
}

const addr = (n) => '0x' + n.toString(16).padStart(40, 'e');
const state = async (id) => (await one(`SELECT state::text s, amount_settled FROM expected_payments WHERE id=$1`, [id]));
const tstate = async (id) => (await one(`SELECT match_state::text s FROM incoming_transfers WHERE id=$1`, [id]));
const matches = async (id) => rows(`SELECT expected_payment_id, amount_applied, confidence::text, matched_by FROM payment_matches WHERE transfer_id=$1`, [id]);
const linked = async (a) => rows(`SELECT customer_id FROM customer_addresses WHERE lower(address)=lower($1)`, [a]);

/* ------------------------------------------------------------------ drill */

const ids = actionIds('apps/web/.next/dev/server');
console.log('=== wiring ===');
check('all three server actions found in the dev output',
  !!(ids.applyToPayment && ids.markNotAPayment && ids.linkSenderToCustomer),
  Object.entries(ids).map(([k, v]) => `${k}=${v.slice(0, 8)}…`).join(' '));
const KEY = await actionKey();
check('the review page renders a usable $ACTION_KEY', !!KEY);

try {
  // ------------------------------------------------------- 1. apply in full
  console.log('\n=== 1. apply in full ===');
  {
    const c = await customer('Apply in full'), ep = await payment(c, 100000);
    const tr = await transfer({ from: addr(1), value: 100000, reason: 'unknown_sender',
      candidates: [{ expected_payment_id: String(ep), remaining: '100000', delta: '0' }] });
    await post(ids.applyToPayment, KEY, { transferId: tr, expectedPaymentId: ep, amount: 100000 });
    const s = await state(ep), m = await matches(tr);
    check('the obligation is settled in full', s.s === 'paid' && s.amount_settled === '100000', `${s.s}/${s.amount_settled}`);
    check('the match is recorded as a human decision, not an auto-match',
      m.length === 1 && m[0].confidence === 'manual' && m[0].matched_by === 'review:dashboard', JSON.stringify(m[0]));
    check('the transfer leaves the queue', (await tstate(tr)).s === 'resolved');

    // Negative control: the same POST against an expected payment that does not
    // exist must be rejected and must leave everything alone.
    const c2 = await customer('Control full'), ep2 = await payment(c2, 100000);
    const tr2 = await transfer({ from: addr(2), value: 100000, reason: 'unknown_sender', candidates: [] });
    const r = await post(ids.applyToPayment, KEY, { transferId: tr2, expectedPaymentId: '99999999', amount: 100000 });
    const s2 = await state(ep2);
    check('negative control: applying to a non-existent obligation changes nothing',
      s2.s === 'due' && s2.amount_settled === '0' && (await tstate(tr2)).s === 'needs_review' && (await matches(tr2)).length === 0,
      `http ${r.status}, obligation still ${s2.s}`);
  }

  // ------------------------------------------------------- 2. apply partial
  console.log('\n=== 2. apply as partial ===');
  {
    const c = await customer('Partial'), ep = await payment(c, 100000);
    const tr = await transfer({ from: addr(3), value: 40000, reason: 'amount_mismatch',
      candidates: [{ expected_payment_id: String(ep), remaining: '100000', delta: '-60000' }] });
    await post(ids.applyToPayment, KEY, { transferId: tr, expectedPaymentId: ep, amount: 40000 });
    const s = await state(ep);
    check('a short payment settles partially and stays outstanding',
      s.s === 'partially_paid' && s.amount_settled === '40000', `${s.s}/${s.amount_settled}`);
    check('negative control: a partial is not reported as paid', s.s !== 'paid', s.s);
  }

  // ------------------------------------------------------- 3. apply surplus
  console.log('\n=== 3. apply with surplus ===');
  {
    const c = await customer('Surplus'), ep = await payment(c, 50000);
    const tr = await transfer({ from: addr(4), value: 80000, reason: 'amount_mismatch',
      candidates: [{ expected_payment_id: String(ep), remaining: '50000', delta: '30000' }] });
    await post(ids.applyToPayment, KEY, { transferId: tr, expectedPaymentId: ep, amount: 50000 });
    const s = await state(ep);
    const surplus = await one(`SELECT (value - COALESCE((SELECT SUM(amount_applied) FROM payment_matches WHERE transfer_id=$1),0)) AS left FROM incoming_transfers WHERE id=$1`, [tr]);
    check('the obligation is settled and the excess stays on the transfer',
      s.s === 'paid' && String(surplus.left) === '30000', `${s.s}, ${surplus.left} unapplied`);

    // Negative control: the engine must refuse to apply more than arrived.
    const c2 = await customer('Control surplus'), ep2 = await payment(c2, 500000);
    const tr2 = await transfer({ from: addr(5), value: 10000, reason: 'amount_mismatch', candidates: [] });
    const r = await post(ids.applyToPayment, KEY, { transferId: tr2, expectedPaymentId: ep2, amount: 500000 });
    const s2 = await state(ep2);
    check('negative control: applying more than the transfer carried is refused',
      s2.amount_settled === '0' && (await matches(tr2)).length === 0, `http ${r.status}, settled ${s2.amount_settled}`);
  }

  // ------------------------------------------------------ 4. not a payment
  console.log('\n=== 4. not a payment ===');
  {
    const tr = await transfer({ from: addr(6), value: 7777, reason: 'unattributed', candidates: [] });
    await post(ids.markNotAPayment, KEY, { transferId: tr });
    const t = await one(`SELECT match_state::text s FROM incoming_transfers WHERE id=$1`, [tr]);
    check('the transfer is marked ignored', t.s === 'ignored', t.s);
    check('it is kept on record, not deleted',
      !!(await one(`SELECT id FROM incoming_transfers WHERE id=$1`, [tr])));
    check('negative control: ignoring never invents a payment', (await matches(tr)).length === 0);
  }

  // ------------------------------------------------- 5. link sender (learning)
  console.log('\n=== 5. link sender to customer (the learning action) ===');
  {
    const c = await customer('Learning'), ep = await payment(c, 65000);
    const sender = addr(7);
    check('the sender starts unlinked', (await linked(sender)).length === 0);
    const tr = await transfer({ from: sender, value: 65000, reason: 'unknown_sender',
      candidates: [{ expected_payment_id: String(ep), remaining: '65000', delta: '0' }] });
    await post(ids.linkSenderToCustomer, KEY, { transferId: tr, customerId: c, expectedPaymentId: ep, amount: 65000 });
    const l = await linked(sender), s = await state(ep);
    check('the sender is now linked to that customer', l.length === 1 && String(l[0].customer_id) === String(c), JSON.stringify(l));
    check('and the obligation was settled in the same action', s.s === 'paid', `${s.s}/${s.amount_settled}`);

    // The point of the action: what needed review once now matches on its own.
    const ep3 = await payment(c, 65000);
    const tr3 = await transfer({ from: sender, value: 65000, reason: 'unknown_sender', candidates: [] });
    const { classifyTransfer } = await import('../apps/worker/src/matcher.js');
    const { pool } = await import('@retainer/db');
    const conn = await pool().connect();
    let verdict;
    try {
      const row = (await conn.query('SELECT * FROM incoming_transfers WHERE id=$1', [tr3])).rows[0];
      verdict = await classifyTransfer(conn, row);
    } finally { conn.release(); }
    check('an identical transfer from that sender now auto-matches — the review does not recur',
      verdict.state === 'auto_matched' && verdict.reason === 'exact_known_sender', `${verdict.state}/${verdict.reason}`);

    // Negative control: linking with no customer chosen must link nothing.
    const unlinked = addr(8);
    const tr4 = await transfer({ from: unlinked, value: 999, reason: 'unattributed', candidates: [] });
    const r = await post(ids.linkSenderToCustomer, KEY, { transferId: tr4, customerId: '' });
    check('negative control: linking without choosing a customer links nothing',
      (await linked(unlinked)).length === 0 && (await tstate(tr4)).s === 'needs_review', `http ${r.status}`);
  }
} finally {
  // Leave no drill rows behind: the dashboard shows real state, and a drill is
  // not real state.
  console.log('\n=== cleanup ===');
  // Order matters: events reference both transfers and expected payments, and
  // deliveries reference events, so unwind from the leaves inwards.
  const C = made.customers, T = made.transfers;
  if (C.length || T.length) {
    await query(
      `DELETE FROM deliveries WHERE event_id IN (
         SELECT id FROM events
          WHERE transfer_id = ANY($2::bigint[])
             OR expected_payment_id IN (SELECT id FROM expected_payments WHERE customer_id = ANY($1::bigint[])))`,
      [C, T]);
    await query(
      `DELETE FROM events
        WHERE transfer_id = ANY($2::bigint[])
           OR expected_payment_id IN (SELECT id FROM expected_payments WHERE customer_id = ANY($1::bigint[]))`,
      [C, T]);
    await query(`DELETE FROM payment_matches WHERE transfer_id = ANY($1::bigint[])`, [T]);
    await query(`DELETE FROM incoming_transfers WHERE id = ANY($1::bigint[])`, [T]);
    await query(`DELETE FROM expected_payments WHERE customer_id = ANY($1::bigint[])`, [C]);
    await query(`DELETE FROM customer_addresses WHERE customer_id = ANY($1::bigint[])`, [C]);
    await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [C]);
  }
  const leftover = await one(`SELECT count(*)::int c FROM customers WHERE label LIKE $1`, [`%[drill ${RUN}]%`]);
  check('the drill left no rows behind', leftover.c === 0, `${leftover.c} remaining`);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await close();
process.exit(fail ? 1 : 0);
