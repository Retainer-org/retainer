import { tx, audit } from '@retainer/db';
import { emit } from './events.js';

/**
 * Overdue detection: move expected payments through upcoming -> due -> overdue.
 *
 * This is the feature the merchant actually asked for. Their words: "I
 * shouldn't have to think about whether the payment happened." Nobody noticing
 * a missing payment was the pain, not charging.
 *
 * It covers both fulfilment methods without special-casing either: a watch
 * payment that never arrives and a pull whose charge failed terminally both
 * leave an expected payment unsatisfied past its due date, and both become
 * overdue here. One overdue path, not two.
 */

const q = async (c, sql, params = []) => (await c.query(sql, params)).rows;

export async function sweepExpectedPayments() {
  return tx(async (c) => {
    // upcoming -> due, once inside the lead time.
    const due = await q(c, `
      UPDATE expected_payments SET state = 'due', updated_at = now()
       WHERE state = 'upcoming'
         AND now() >= due_date - make_interval(secs => lead_time_seconds)
      RETURNING id, customer_id, amount_expected, amount_settled, due_date, fulfilment::text AS fulfilment`);

    // due | partially_paid -> overdue, once past the due date plus grace.
    const overdue = await q(c, `
      UPDATE expected_payments SET state = 'overdue', updated_at = now()
       WHERE state IN ('due','partially_paid')
         AND now() > due_date + make_interval(secs => grace_seconds)
      RETURNING id, customer_id, amount_expected, amount_settled, due_date, fulfilment::text AS fulfilment,
                (amount_expected - amount_settled) AS outstanding`);

    for (const ep of overdue) {
      // What the merchant is told, and why: which obligation, whose, how much
      // is still outstanding, and how it was meant to be satisfied.
      await emit(c, { type: 'payment.overdue', expectedPaymentId: ep.id,
        payload: { customer_id: String(ep.customer_id), amount_expected: String(ep.amount_expected),
                   amount_settled: String(ep.amount_settled), outstanding: String(ep.outstanding),
                   due_date: ep.due_date instanceof Date ? ep.due_date.toISOString() : ep.due_date,
                   fulfilment: ep.fulfilment } });
      await audit(c, { actor: 'sweep', event: 'payment.overdue', detail: { expectedPaymentId: String(ep.id) } });
    }

    return { becameDue: due.map((r) => String(r.id)), becameOverdue: overdue.map((r) => String(r.id)) };
  });
}

/**
 * Keep expected payments in step with the charge engine.
 *
 * The reconciler is still the only writer of charges.state = 'confirmed'; this
 * reads that verdict and settles the obligation behind it. A charge is never
 * the source of truth for payment -- the on-chain events are, and the
 * reconciler is what reads them.
 */
export async function settleFromConfirmedCharges() {
  return tx(async (c) => {
    const rows = await q(c, `
      SELECT ch.id AS charge_id, ch.expected_payment_id, ch.confirmed_amount, ch.confirmed_tx_hash,
             ep.amount_expected, ep.customer_id
        FROM charges ch
        JOIN expected_payments ep ON ep.id = ch.expected_payment_id
       WHERE ch.state = 'confirmed'
         AND ch.confirmed_amount IS NOT NULL
         AND ep.state <> 'paid'
       FOR UPDATE OF ep`);

    const settled = [];
    for (const r of rows) {
      const paid = BigInt(r.confirmed_amount) >= BigInt(r.amount_expected);
      await c.query(
        `UPDATE expected_payments SET amount_settled = $2, state = $3, updated_at = now() WHERE id = $1`,
        [r.expected_payment_id, String(r.confirmed_amount), paid ? 'paid' : 'partially_paid']);
      if (paid) {
        await emit(c, { type: 'payment.paid', expectedPaymentId: r.expected_payment_id, chargeId: r.charge_id,
          payload: { amount_expected: String(r.amount_expected), amount_settled: String(r.confirmed_amount),
                     customer_id: String(r.customer_id), via: 'pull', tx_hash: r.confirmed_tx_hash } });
      }
      settled.push(String(r.expected_payment_id));
    }
    return settled;
  });
}
