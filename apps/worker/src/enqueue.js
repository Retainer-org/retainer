import { tx, audit } from '@retainer/db';
import { periodFor } from '@retainer/chain';

/**
 * Create the charge for a permission's CURRENT billing period, together with the
 * expected payment it fulfils. The one place a pull charge is created.
 *
 * Since migration 003 a charge cannot exist without an expected payment
 * (charges.expected_payment_id is NOT NULL): the obligation is the top-level
 * object and a pull charge is one way to satisfy it. The CLI's enqueue predated
 * that and kept inserting bare charges, so every enqueue after 003 failed on the
 * constraint -- and nothing else creates pull charges. This creates both, in one
 * transaction.
 *
 * Idempotent on (permission_id, period_start): enqueueing twice for one period
 * returns the existing charge and creates nothing.
 */
export async function enqueuePullCharge(opts) {
  return tx((c) => createPullCharge(c, opts));
}

/**
 * The same, inside a transaction the caller owns. `dueAt` (unix seconds) sets when the worker may
 * first attempt it; without it the charge is due now, exactly as before. A billing link uses this
 * to create its first charge in the same transaction as the permission.
 */
export async function createPullCharge(c, { permission: key, amount = null, source = 'fixed', now = Math.floor(Date.now() / 1000), dueAt = null, actor = 'operator' }) {
  {
    const p = (await c.query('SELECT * FROM permissions WHERE id::text = $1 OR permission_hash = $1', [String(key)])).rows[0];
    if (!p) throw new Error('permission not found');

    // period_start is derived from the permission, never chosen -- that is what makes
    // UNIQUE (permission_id, period_start) a real idempotency guarantee.
    const per = periodFor({ start: p.start_ts, end: p.end_ts, period: p.period_seconds }, now);
    if (per.state !== 'ACTIVE') {
      // Still enqueue: the classifier is what should report NOT_STARTED/EXPIRED,
      // so the drills exercise the real path rather than short-circuiting here.
      const anchor = per.state === 'NOT_STARTED' ? BigInt(p.start_ts) : BigInt(p.end_ts) - BigInt(p.period_seconds);
      per.periodStart = anchor; per.periodEnd = anchor + BigInt(p.period_seconds);
    }

    const existing = (await c.query(
      `SELECT id, state::text AS state, expected_payment_id FROM charges WHERE permission_id = $1 AND period_start = $2`,
      [p.id, per.periodStart.toString()])).rows[0];
    if (existing) return { created: false, reason: 'idempotency key already exists for this period', charge: existing };

    // What is owed. A fixed charge owes its amount. A usage charge's amount is computed
    // at charge time, but an obligation of zero is not an obligation (and the schema
    // refuses one), so it owes what has been recorded so far and is corrected when the
    // charger resolves the final figure.
    let chargeAmount, owed;
    if (source === 'usage') {
      const total = BigInt((await c.query(
        `SELECT COALESCE(SUM(units * unit_price), 0) AS total FROM usage_records WHERE permission_id = $1 AND period_start = $2`,
        [p.id, per.periodStart.toString()])).rows[0].total);
      if (total <= 0n) throw new Error('no usage recorded for this period yet; record usage before enqueueing a usage charge');
      chargeAmount = '0'; owed = total.toString();
    } else {
      if (amount == null || BigInt(amount) <= 0n) throw new Error('--amount required for a fixed charge, and it must be positive');
      chargeAmount = owed = BigInt(amount).toString();
    }

    // The customer is whoever owns the paying account -- the same shape migration 003's
    // backfill used, so old and new obligations group the same way on the dashboard.
    let customerId = (await c.query(
      `SELECT customer_id FROM customer_addresses WHERE chain_id = $1 AND lower(address) = lower($2)`,
      [p.chain_id, p.account])).rows[0]?.customer_id;
    let createdCustomer = false;
    if (!customerId) {
      customerId = (await c.query(`INSERT INTO customers (label) VALUES ($1) RETURNING id`,
        [`Customer ${p.account.slice(0, 10)}…`])).rows[0].id;
      await c.query(`INSERT INTO customer_addresses (customer_id, chain_id, address, note)
                     VALUES ($1, $2, $3, 'linked from permission payer account')`, [customerId, p.chain_id, p.account]);
      createdCustomer = true;
    }

    // Due by the end of the period it pays for. (The 003 backfill dated historical charges
    // by period_start; for a new charge that would make it overdue the moment it exists.)
    const ep = (await c.query(
      `INSERT INTO expected_payments
         (customer_id, amount_expected, token, chain_id, due_date, state, fulfilment, permission_id, reference)
       VALUES ($1, $2, $3, $4, to_timestamp($5),
               CASE WHEN now() >= to_timestamp($5) - make_interval(secs => 259200)
                    THEN 'due'::expected_payment_state ELSE 'upcoming'::expected_payment_state END,
               'pull', $6, $7)
       RETURNING id`,
      [customerId, owed, p.token, p.chain_id, per.periodEnd.toString(), p.id, `enqueue:permission:${p.id}:${per.periodStart}`])).rows[0].id;

    const ch = (await c.query(
      `INSERT INTO charges (permission_id, period_start, period_end, amount, amount_source, expected_payment_id, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE(to_timestamp($7), now())) RETURNING id, state::text AS state`,
      [p.id, per.periodStart.toString(), per.periodEnd.toString(), chargeAmount, source, ep, dueAt])).rows[0];

    await audit(c, { actor, event: 'charge.enqueued', permissionId: p.id, chargeId: ch.id,
      detail: { expectedPaymentId: String(ep), customerId: String(customerId), periodStart: per.periodStart.toString(),
                amount: chargeAmount, owed, source } });

    return { created: true, charge: ch, expectedPaymentId: String(ep), customerId: String(customerId), createdCustomer,
             periodStart: per.periodStart.toString(), periodEnd: per.periodEnd.toString(), amountSource: source };
  }
}
