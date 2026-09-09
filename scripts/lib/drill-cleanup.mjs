/**
 * Shared drill teardown.
 *
 * A drill that leaves residue is a drill that will eventually be mistaken for
 * data -- the dashboard spent a week showing seven identically-named customers
 * from seven drill runs. So every drill sweeps at setup (clearing whatever a
 * crashed run left) and again at the end (leaving nothing of its own).
 *
 * Residue is identified only by markers a drill puts there deliberately: the
 * drill customer labels, the `drill:` reference prefix, the two disposable test
 * senders, and the loopback/example.test alert destinations. Nothing is
 * identified by exclusion, so a row that is not drill residue cannot be swept
 * because it happened to look unusual.
 *
 * The protected set -- customer 1, the twelve charges, their permissions and
 * the six router transfers behind the publicly cited hashes -- is asserted
 * untouched before the delete runs, and the sweep throws rather than proceed if
 * the selection ever reaches it.
 */
import { query } from '@retainer/db';

const rows = async (sql, p = []) => (await query(sql, p)).rows;

/** Identify residue. Exported so a caller can see what would go before it goes. */
export async function findDrillResidue() {
  const senders = [process.env.TEST_USER_ADDRESS, process.env.TEST_SENDER_B_ADDRESS]
    .filter(Boolean).map((s) => s.toLowerCase());

  const customers = await rows(
    `SELECT id, label FROM customers
      WHERE label LIKE 'Drill customer%' OR label LIKE 'Alert drill%' OR label LIKE '%[drill %' OR label = 'Web drill customer'
      ORDER BY id`);
  const C = customers.map((r) => r.id);

  const payments = await rows(
    `SELECT id FROM expected_payments WHERE customer_id = ANY($1::bigint[]) OR reference LIKE 'drill:%' OR reference LIKE 'webdrill:%'`,
    [C]);
  const E = payments.map((r) => r.id);

  // Never the router's own transfers: those are the on-chain evidence behind
  // the charges cited on the landing page.
  const transfers = await rows(
    `SELECT id FROM incoming_transfers
      WHERE match_state <> 'internal'
        AND (lower(from_address) = ANY($1::text[]) OR block_number < 1000)`,
    [senders]);
  const T = transfers.map((r) => r.id);

  const dests = await rows(
    `SELECT id FROM alert_destinations WHERE target LIKE 'http://127.0.0.1%' OR target LIKE 'http://localhost%' OR target = 'ops@example.test'`);
  const D = dests.map((r) => r.id);

  return { C, E, T, D, labels: [...new Set(customers.map((c) => c.label))] };
}

/** Delete it, refusing if the selection reaches anything publicly cited. */
export async function sweepDrillResidue({ quiet = false } = {}) {
  const { C, E, T, D, labels } = await findDrillResidue();

  if (C.map(String).includes('1')) throw new Error('refusing to sweep: customer 1 is in the delete set');
  const citedEps = (await rows(`SELECT id FROM expected_payments WHERE customer_id = 1`)).map((r) => String(r.id));
  const hitEp = E.map(String).filter((x) => citedEps.includes(x));
  if (hitEp.length) throw new Error(`refusing to sweep: publicly cited expected payments in the delete set: ${hitEp}`);
  const internal = (await rows(`SELECT id FROM incoming_transfers WHERE match_state = 'internal'`)).map((r) => String(r.id));
  const hitT = T.map(String).filter((x) => internal.includes(x));
  if (hitT.length) throw new Error(`refusing to sweep: router transfers in the delete set: ${hitT}`);

  await query(`DELETE FROM deliveries WHERE destination_id = ANY($1::bigint[])
                  OR event_id IN (SELECT id FROM events WHERE transfer_id = ANY($2::bigint[]) OR expected_payment_id = ANY($3::bigint[]))`, [D, T, E]);
  await query(`DELETE FROM events WHERE transfer_id = ANY($1::bigint[]) OR expected_payment_id = ANY($2::bigint[])`, [T, E]);
  await query(`DELETE FROM payment_matches WHERE transfer_id = ANY($1::bigint[]) OR expected_payment_id = ANY($2::bigint[])`, [T, E]);
  await query(`DELETE FROM incoming_transfers WHERE id = ANY($1::bigint[])`, [T]);
  await query(`DELETE FROM expected_payments WHERE id = ANY($1::bigint[])`, [E]);
  await query(`DELETE FROM customer_addresses WHERE customer_id = ANY($1::bigint[])`, [C]);
  await query(`DELETE FROM customers WHERE id = ANY($1::bigint[])`, [C]);
  await query(`DELETE FROM alert_destinations WHERE id = ANY($1::bigint[])`, [D]);

  const n = { customers: C.length, payments: E.length, transfers: T.length, destinations: D.length };
  if (!quiet && (n.customers || n.payments || n.transfers || n.destinations))
    console.log(`  swept: ${n.customers} customers, ${n.payments} expected payments, ${n.transfers} transfers, ${n.destinations} alert destinations` +
      (labels.length ? `  (${labels.join(' | ')})` : ''));
  return n;
}

/** Assert nothing of ours is left. Drills call this as their last check. */
export async function assertNoResidue() {
  const { C, E, T, D } = await findDrillResidue();
  return C.length + E.length + T.length + D.length;
}
