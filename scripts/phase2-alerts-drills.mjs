/**
 * Prove the alerting half: overdue detection, webhook signing and retry, and
 * the email transport boundary.
 *
 * As with the matching drills, every assertion has a negative control that is
 * confirmed to actually fail -- a check that passes because it never ran is
 * worse than no check.
 */
import { createServer } from 'node:http';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { config } from '@retainer/chain';
import { query, close } from '@retainer/db';
import { sweepExpectedPayments } from '../apps/worker/src/sweep.js';
import { deliverAlerts, addDestination, signPayload, verifySignature, renderEmail } from '../apps/worker/src/alerts.js';
import { sweepDrillResidue, assertNoResidue } from './lib/drill-cleanup.mjs';

const cfg = config();
const rows = async (sql, p = []) => (await query(sql, p)).rows;
let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };

const EMAIL_FILE = '/tmp/retainer-drill-emails.log';
process.env.ALERT_EMAIL_TRANSPORT = 'file';
process.env.ALERT_EMAIL_FILE = EMAIL_FILE;
if (existsSync(EMAIL_FILE)) rmSync(EMAIL_FILE);

// ------------------------------------------------- a real webhook receiver
const received = [];
let failNext = 2;                       // force two failures to exercise retry
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (failNext > 0) { failNext--; res.writeHead(500).end('nope'); return; }
    received.push({ body, sig: req.headers['retainer-signature'], eventId: req.headers['retainer-event-id'], type: req.headers['retainer-event-type'] });
    res.writeHead(200).end('ok');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/hook`;
const SECRET = 'drill-secret-not-a-real-key';

console.log('=== setup ===');
await sweepDrillResidue();
const hook = await addDestination({ channel: 'webhook', target: url, secret: SECRET });
const mail = await addDestination({ channel: 'email', target: 'ops@example.test' });
console.log(`  webhook -> ${url}\n  email   -> ops@example.test`);

// ------------------------------------------------------ overdue detection
console.log('\n=== overdue detection ===');
const cust = (await rows(`INSERT INTO customers (label) VALUES ('Alert drill customer') RETURNING id`))[0].id;
const late = (await rows(
  `INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, state, fulfilment, reference)
   VALUES ($1, 555000, $2, $3, now() - interval '2 days', 'due', 'watch', 'drill:overdue') RETURNING id`,
  [cust, cfg.usdc, cfg.chainId]))[0].id;
const soon = (await rows(
  `INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, lead_time_seconds, state, fulfilment, reference)
   VALUES ($1, 444000, $2, $3, now() + interval '1 day', 259200, 'upcoming', 'watch', 'drill:becoming-due') RETURNING id`,
  [cust, cfg.usdc, cfg.chainId]))[0].id;
const far = (await rows(
  `INSERT INTO expected_payments (customer_id, amount_expected, token, chain_id, due_date, lead_time_seconds, state, fulfilment, reference)
   VALUES ($1, 333000, $2, $3, now() + interval '30 days', 259200, 'upcoming', 'watch', 'drill:still-upcoming') RETURNING id`,
  [cust, cfg.usdc, cfg.chainId]))[0].id;

const swept = await sweepExpectedPayments();
const st = async (id) => (await rows('SELECT state::text s FROM expected_payments WHERE id=$1', [id]))[0].s;
check('past due -> overdue', (await st(late)) === 'overdue', await st(late));
check('inside the lead time -> due', (await st(soon)) === 'due', await st(soon));
check('beyond the lead time stays upcoming (negative control: the sweep is selective, not blanket)',
  (await st(far)) === 'upcoming', await st(far));
const overdueEvent = await rows(`SELECT id, payload FROM events WHERE type='payment.overdue' AND expected_payment_id=$1`, [late]);
check('payment.overdue emitted once, with the outstanding amount', overdueEvent.length === 1 && overdueEvent[0].payload.outstanding === '555000',
  `${overdueEvent.length} event(s), outstanding=${overdueEvent[0]?.payload?.outstanding}`);
const noEventForFar = await rows(`SELECT count(*)::int c FROM events WHERE type='payment.overdue' AND expected_payment_id=$1`, [far]);
check('no overdue event for a payment that is not overdue', noEventForFar[0].c === 0);

// ------------------------------------------------------------- signing
console.log('\n=== webhook signature ===');
const body = JSON.stringify({ hello: 'world' });
const { header } = signPayload(SECRET, body);
check('a correctly signed body verifies', verifySignature(SECRET, body, header));
check('negative control: the wrong secret fails', !verifySignature('wrong-secret', body, header));
check('negative control: a tampered body fails', !verifySignature(SECRET, body + ' ', header));
const old = signPayload(SECRET, body, Math.floor(Date.now() / 1000) - 3600);
check('negative control: a replayed old signature fails', !verifySignature(SECRET, body, old.header));

// ------------------------------------------------------------ delivery
console.log('\n=== delivery, retry and the transport boundary ===');
let rounds = 0;
for (let i = 0; i < 12; i++) {
  const out = await deliverAlerts({ limit: 50 });
  rounds++;
  if (!out.length) break;
  // Retries are scheduled into the future; pull them forward so the drill does
  // not have to wait a minute between attempts.
  await query(`UPDATE deliveries SET next_attempt_at = now() WHERE state = 'failed'`);
}
const delivered = await rows(
  `SELECT d.state::text state, d.channel::text channel, d.attempts, d.transport, d.last_status, e.type
     FROM deliveries d JOIN events e ON e.id = d.event_id
    WHERE d.destination_id IN ($1,$2) ORDER BY d.id`, [hook.id, mail.id]);
const web = delivered.filter((d) => d.channel === 'webhook');
const eml = delivered.filter((d) => d.channel === 'email');

check('every webhook delivery ended up delivered', web.length > 0 && web.every((d) => d.state === 'delivered'), `${web.filter(d=>d.state==='delivered').length}/${web.length}`);
check('retry actually happened (the receiver rejected the first two)', web.some((d) => d.attempts > 1), `max attempts ${Math.max(...web.map(d=>d.attempts))}`);
check('the receiver got a valid signature on every accepted delivery',
  received.length > 0 && received.every((r) => verifySignature(SECRET, r.body, r.sig)), `${received.length} received`);
check('each delivery carried an event id for receiver-side dedupe', received.every((r) => !!r.eventId));

// The transport boundary: the email never touched a network, and the delivery
// record names which transport handled it.
check('every email delivery ended up delivered', eml.length > 0 && eml.every((d) => d.state === 'delivered'), `${eml.filter(d=>d.state==='delivered').length}/${eml.length}`);
check('the delivery record names the transport that handled it', eml.every((d) => d.transport === 'file'), eml.map(d=>d.transport).join(','));
const mailbox = existsSync(EMAIL_FILE) ? readFileSync(EMAIL_FILE, 'utf8') : '';
check('the file transport actually wrote the message', mailbox.includes('To: ops@example.test'), `${mailbox.length} bytes`);
check('an overdue email carries the outstanding amount a merchant would act on', /Outstanding: 0\.555000 USDC/.test(mailbox));

// One delivery, one attempt-chain, forever.
const dupes = await rows(`SELECT event_id, destination_id, count(*)::int c FROM deliveries GROUP BY 1,2 HAVING count(*) > 1`);
check('idempotent fan-out: one delivery row per (event, destination)', dupes.length === 0, `${dupes.length} duplicated`);

// Rendering is pure, so it can be checked without delivering anything.
const rendered = renderEmail({ type: 'charge.failed', charge_id: '3', payload: { mode: 'INSUFFICIENT_BALANCE', disposition: 'failed_retryable', detail: 'balance=1 want=2', next_attempt_at: '2026-09-09T12:00:00Z' } });
check('charge.failed alert carries the classifier verdict, not a restatement',
  rendered.text.includes('INSUFFICIENT_BALANCE') && rendered.text.includes('failed_retryable'), rendered.subject);

// ---------------------------------------------------------------- teardown
console.log('\n=== teardown ===');
await sweepDrillResidue();
const left = await assertNoResidue();
check('the drill leaves no rows behind', left === 0, `${left} remaining`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed  (delivery rounds: ${rounds})`);
server.close();
await close();
process.exit(fail ? 1 : 0);
