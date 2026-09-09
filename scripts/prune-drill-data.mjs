/**
 * Remove drill residue from the database, and prove the publicly cited data
 * survived untouched.
 *
 * The landing page, the docs and the README cite twelve charges, their
 * permissions and ten transaction hashes. Those rows are load-bearing public
 * claims: if a prune altered one, the site would start describing something
 * that no longer exists. So this is not a delete script with a careful author
 * -- it is a delete inside one transaction that re-reads every protected row
 * field-by-field afterwards and ROLLS BACK unless the snapshot is byte-identical.
 *
 * Run: npm run prune:drills            (report what would go, change nothing)
 *      npm run prune:drills -- --apply (do it)
 */
import { pool, close } from '@retainer/db';

const APPLY = process.argv.includes('--apply');
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Every table that carries a publicly cited fact, in full. */
const PROTECTED = {
  customers:          `SELECT * FROM customers WHERE id = 1 ORDER BY id`,
  permissions:        `SELECT * FROM permissions ORDER BY id`,
  charges:            `SELECT * FROM charges ORDER BY id`,
  charge_attempts:    `SELECT * FROM charge_attempts ORDER BY id`,
  onchain_events:     `SELECT * FROM onchain_events ORDER BY id`,
  expected_payments:  `SELECT * FROM expected_payments WHERE customer_id = 1 ORDER BY id`,
  router_transfers:   `SELECT * FROM incoming_transfers WHERE match_state = 'internal' ORDER BY id`,
  indexer_state:      `SELECT * FROM indexer_state ORDER BY id`,
  watch_cursors:      `SELECT * FROM watch_cursors ORDER BY name`,
};

const snapshot = async (c) => {
  const out = {};
  for (const [k, sql] of Object.entries(PROTECTED)) out[k] = (await c.query(sql)).rows.map(j);
  return out;
};

const c = await pool().connect();
let committed = false;
try {
  await c.query('BEGIN');

  // ---- what counts as debris, stated explicitly rather than by exclusion ----
  const senders = [process.env.TEST_USER_ADDRESS, process.env.TEST_SENDER_B_ADDRESS].filter(Boolean);
  if (senders.length !== 2) throw new Error('TEST_USER_ADDRESS and TEST_SENDER_B_ADDRESS must be set');

  const customers = (await c.query(
    `SELECT id, label FROM customers WHERE label LIKE 'Drill customer%' OR label LIKE 'Alert drill%' OR label LIKE '%[drill %' ORDER BY id`)).rows;
  const transfers = (await c.query(
    `SELECT id, from_address, block_number FROM incoming_transfers
      WHERE match_state <> 'internal'
        AND (lower(from_address) = ANY($1::text[]) OR block_number < 1000)
      ORDER BY id`, [senders.map((s) => s.toLowerCase())])).rows;
  const dests = (await c.query(
    `SELECT id, target FROM alert_destinations WHERE target LIKE 'http://127.0.0.1%' OR target = 'ops@example.test' ORDER BY id`)).rows;

  const C = customers.map((x) => x.id), T = transfers.map((x) => x.id), D = dests.map((x) => x.id);

  // ---- the safety net: the delete set must not intersect the protected set ----
  const before = await snapshot(c);
  const protectedTransferIds = (await c.query(`SELECT id FROM incoming_transfers WHERE match_state = 'internal'`)).rows.map((r) => String(r.id));
  const protectedEpIds = (await c.query(`SELECT id FROM expected_payments WHERE customer_id = 1`)).rows.map((r) => String(r.id));
  const overlapT = T.map(String).filter((x) => protectedTransferIds.includes(x));
  const overlapC = C.map(String).filter((x) => x === '1');
  const doomedEps = (await c.query(`SELECT id FROM expected_payments WHERE customer_id = ANY($1::bigint[])`, [C])).rows.map((r) => String(r.id));
  const overlapE = doomedEps.filter((x) => protectedEpIds.includes(x));
  if (overlapT.length || overlapC.length || overlapE.length)
    throw new Error(`delete set intersects protected set: transfers=${overlapT} customers=${overlapC} payments=${overlapE}`);

  console.log('=== to remove ===');
  console.log(`  customers            ${C.length}  (${[...new Set(customers.map((x) => x.label))].join(' | ')})`);
  console.log(`  expected payments    ${doomedEps.length}`);
  console.log(`  incoming transfers   ${T.length}  (drill senders + synthetic)`);
  console.log(`  alert destinations   ${D.length}  (${dests.map((x) => x.target).join(', ')})`);
  console.log('\n=== to keep, untouched ===');
  for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(20)} ${v.length}`);

  // ---------------------------------------------- the deletes, leaves inwards
  await c.query(`DELETE FROM deliveries WHERE destination_id = ANY($1::bigint[])
                    OR event_id IN (SELECT id FROM events WHERE transfer_id = ANY($2::bigint[])
                                       OR expected_payment_id = ANY($3::bigint[]))`, [D, T, doomedEps]);
  await c.query(`DELETE FROM events WHERE transfer_id = ANY($1::bigint[]) OR expected_payment_id = ANY($2::bigint[])`, [T, doomedEps]);
  await c.query(`DELETE FROM payment_matches WHERE transfer_id = ANY($1::bigint[]) OR expected_payment_id = ANY($2::bigint[])`, [T, doomedEps]);
  await c.query(`DELETE FROM incoming_transfers WHERE id = ANY($1::bigint[])`, [T]);
  await c.query(`DELETE FROM expected_payments WHERE id = ANY($1::bigint[])`, [doomedEps]);
  await c.query(`DELETE FROM customer_addresses WHERE customer_id = ANY($1::bigint[])`, [C]);
  await c.query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [C]);
  await c.query(`DELETE FROM alert_destinations WHERE id = ANY($1::bigint[])`, [D]);

  // ------------------------------------- field-by-field diff, before committing
  const after = await snapshot(c);
  const diffs = [];
  for (const k of Object.keys(PROTECTED)) {
    const b = before[k], a = after[k];
    if (b.length !== a.length) { diffs.push(`${k}: ${b.length} rows -> ${a.length}`); continue; }
    for (let i = 0; i < b.length; i++) if (b[i] !== a[i]) diffs.push(`${k}[${i}] changed:\n    before ${b[i]}\n    after  ${a[i]}`);
  }
  console.log('\n=== protected-set diff, field by field ===');
  if (diffs.length) { diffs.forEach((d) => console.log('  ' + d)); throw new Error(`${diffs.length} protected row(s) changed -- rolling back`); }
  const fields = Object.values(before).flat().reduce((n, row) => n + Object.keys(JSON.parse(row)).length, 0);
  console.log(`  identical: ${Object.values(before).flat().length} rows, ${fields} fields, 0 differences`);

  // Negative control: the diff must be able to see a change, or it proves nothing.
  await c.query(`SAVEPOINT ctl`);
  await c.query(`UPDATE charges SET attempts = attempts + 1 WHERE id = 1`);
  const ctl = await snapshot(c);
  const sees = ctl.charges[0] !== before.charges[0];
  await c.query(`ROLLBACK TO SAVEPOINT ctl`);
  console.log(`  [${sees ? 'PASS' : 'FAIL'}] negative control: a single changed field on charge #1 is detected`);
  if (!sees) throw new Error('the diff is blind -- rolling back');

  if (APPLY) { await c.query('COMMIT'); committed = true; console.log('\nCOMMITTED.'); }
  else { await c.query('ROLLBACK'); console.log('\nDry run — nothing changed. Re-run with --apply.'); }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`\nROLLED BACK: ${e.message}`);
  process.exitCode = 1;
} finally {
  c.release();
  await close();
}
if (APPLY && !committed) process.exitCode = 1;
