import { config } from '@retainer/chain';
import { tx, audit } from '@retainer/db';
import { emit } from './events.js';

/**
 * Attribute an incoming transfer to an expected payment, or send it to review.
 *
 * The governing rule: never auto-match ambiguously. A wrong auto-match is worse
 * than no match, because it silently marks a customer paid who has not paid.
 *
 * Two boolean signals, deliberately not a numeric score -- a score invites a
 * threshold, and a threshold is how ambiguous auto-matches happen:
 *
 *   senderKnown(ep)  the transfer's sender is a known address of ep's customer
 *   amountExact(ep)  the transfer equals ep's REMAINING amount (so an exact
 *                    top-up on a partially paid obligation still counts)
 *
 * With S = known-sender candidates, A = exact-amount candidates, X = S n A,
 * `|X| == 1` is the ONLY path that writes auto_matched -- mirroring the
 * reconciler being the sole writer of `confirmed`.
 */

const q = async (c, sql, params = []) => (await c.query(sql, params)).rows;

/** Open obligations a transfer could satisfy, on the same chain and token. */
async function candidates(c, transfer) {
  return q(c, `
    SELECT ep.id, ep.customer_id, ep.amount_expected, ep.amount_settled, ep.due_date,
           ep.state::text AS state, ep.fulfilment::text AS fulfilment, ep.reference,
           (ep.amount_expected - ep.amount_settled) AS remaining
      FROM expected_payments ep
     WHERE ep.chain_id = $1
       AND lower(ep.token) = lower($2)
       AND ep.state IN ('upcoming','due','overdue','partially_paid')
       -- A pull already in flight or settled must not also be satisfied by a
       -- transfer: two systems settling one obligation is where double-counts
       -- come from. Such a payment is still reviewable, just never automatic.
       AND NOT EXISTS (SELECT 1 FROM charges ch
                        WHERE ch.expected_payment_id = ep.id
                          AND ch.state IN ('in_flight','confirmed'))
     ORDER BY ep.due_date`, [transfer.chain_id, transfer.token]);
}

const evidence = (list, value, note) => list.map((ep) => ({
  expected_payment_id: String(ep.id),
  customer_id: String(ep.customer_id),
  reference: ep.reference,
  amount_expected: String(ep.amount_expected),
  remaining: String(ep.remaining),
  delta: (BigInt(value) - BigInt(ep.remaining)).toString(), // negative = short
  due_date: ep.due_date instanceof Date ? ep.due_date.toISOString() : ep.due_date,
  fulfilment: ep.fulfilment,
  note,
}));

/**
 * Pure-ish classification: reads state, decides, writes nothing.
 * Returned `apply` is non-null only for the single auto-match case.
 */
export async function classifyTransfer(c, transfer) {
  const cfg = config();

  // Our own router paying the treasury is a pull fulfilment the reconciler has
  // already accounted for. Verified necessary: every historic incoming transfer
  // to the treasury came from the router. This is a STATE, not a filter -- a
  // filter can be forgotten, a state is visible and auditable.
  if (transfer.from_address.toLowerCase() === cfg.router.toLowerCase()) {
    return { state: 'internal', reason: 'router_fulfilment', candidates: [], apply: null };
  }

  // (chain_id, address) is UNIQUE, so a sender maps to at most one customer.
  const senderCustomerId = (await q(c,
    `SELECT customer_id FROM customer_addresses WHERE chain_id = $1 AND lower(address) = lower($2)`,
    [transfer.chain_id, transfer.from_address]))[0]?.customer_id ?? null;

  const C = await candidates(c, transfer);
  const S = senderCustomerId ? C.filter((ep) => String(ep.customer_id) === String(senderCustomerId)) : [];
  const A = C.filter((ep) => BigInt(ep.remaining) === BigInt(transfer.value));
  const X = S.filter((ep) => A.some((a) => String(a.id) === String(ep.id)));

  if (X.length === 1) {
    return { state: 'auto_matched', reason: 'exact_known_sender',
             candidates: evidence(X, transfer.value, 'exact remaining amount from a known sender'), apply: X[0] };
  }
  if (X.length > 1) {
    return { state: 'needs_review', reason: 'ambiguous_multiple_exact',
             candidates: evidence(X, transfer.value, 'exact amount, more than one candidate — pick one'), apply: null };
  }
  if (S.length > 0) {
    // Known customer, wrong amount. Short could be a partial OR a negotiated
    // discount, and those mean opposite things about whether money is still
    // owed. Nothing in the data distinguishes them, so a human decides.
    return { state: 'needs_review', reason: 'amount_mismatch',
             candidates: evidence(S, transfer.value, 'known sender, amount differs — partial payment or negotiated discount'), apply: null };
  }
  if (A.length > 0) {
    return { state: 'needs_review', reason: 'unknown_sender',
             candidates: evidence(A, transfer.value, 'amount matches, but this sender is not linked to any customer'), apply: null };
  }
  if (senderCustomerId) {
    // Known customer with nothing open. Calling this "unattributed" would be
    // false -- we know who sent it, just not what for.
    return { state: 'needs_review', reason: 'no_open_payment_for_sender',
             candidates: [{ customer_id: String(senderCustomerId), note: 'sender is a known customer with no open expected payment' }], apply: null };
  }
  return { state: 'needs_review', reason: 'unattributed', candidates: [], apply: null };
}

/**
 * Apply a transfer (or part of it) to an expected payment.
 *
 * Locks the transfer row so concurrent applications cannot together exceed its
 * value, and only ever advances amount_settled from a confirmed transfer.
 */
export async function applyMatch(c, { transfer, expectedPaymentId, amount, confidence, by }) {
  await c.query('SELECT 1 FROM incoming_transfers WHERE id = $1 FOR UPDATE', [transfer.id]);

  const applied = BigInt((await q(c,
    `SELECT COALESCE(SUM(amount_applied), 0) AS s FROM payment_matches WHERE transfer_id = $1`,
    [transfer.id]))[0].s);
  const want = BigInt(amount);
  if (want <= 0n) throw new Error('amount_applied must be positive');
  if (applied + want > BigInt(transfer.value)) {
    throw new Error(`applying ${want} would exceed the transfer's value (${applied} of ${transfer.value} already applied)`);
  }

  const ep = (await q(c,
    `SELECT id, customer_id, amount_expected, amount_settled, state::text AS state
       FROM expected_payments WHERE id = $1 FOR UPDATE`, [expectedPaymentId]))[0];
  if (!ep) throw new Error(`expected payment ${expectedPaymentId} not found`);

  const remaining = BigInt(ep.amount_expected) - BigInt(ep.amount_settled);
  const surplus = want > remaining ? want - remaining : 0n;
  const settled = BigInt(ep.amount_settled) + want;

  await c.query(
    `INSERT INTO payment_matches (expected_payment_id, transfer_id, amount_applied, surplus, confidence, matched_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [ep.id, transfer.id, want.toString(), surplus.toString(), confidence, by]);

  const nowPaid = settled >= BigInt(ep.amount_expected);
  await c.query(
    `UPDATE expected_payments SET amount_settled = $2, state = $3, updated_at = now() WHERE id = $1`,
    [ep.id, settled.toString(), nowPaid ? 'paid' : 'partially_paid']);

  await audit(c, { actor: by, event: 'payment.matched', txHash: transfer.tx_hash,
    detail: { expectedPaymentId: String(ep.id), transferId: String(transfer.id),
              amountApplied: want.toString(), surplus: surplus.toString(), confidence } });

  await emit(c, { type: 'payment.matched', expectedPaymentId: ep.id, transferId: transfer.id,
    payload: { amount_applied: want.toString(), surplus: surplus.toString(), confidence, matched_by: by,
               tx_hash: transfer.tx_hash, customer_id: String(ep.customer_id) } });

  if (nowPaid) {
    await emit(c, { type: 'payment.paid', expectedPaymentId: ep.id, transferId: transfer.id,
      payload: { amount_expected: String(ep.amount_expected), amount_settled: settled.toString(),
                 customer_id: String(ep.customer_id), via: 'watch' } });
  }
  return { expectedPaymentId: String(ep.id), applied: want.toString(), surplus: surplus.toString(), paid: nowPaid };
}

/** Classify every pending transfer. Auto-matches only the unambiguous ones. */
export async function matchPendingTransfers({ limit = 50 } = {}) {
  const results = [];
  for (;;) {
    const done = await tx(async (c) => {
      const t = (await q(c,
        `SELECT * FROM incoming_transfers WHERE match_state = 'pending'
          ORDER BY block_number, log_index FOR UPDATE SKIP LOCKED LIMIT 1`))[0];
      if (!t) return true;

      const verdict = await classifyTransfer(c, t);

      await c.query(
        `UPDATE incoming_transfers SET match_state = $2, match_reason = $3, candidates = $4 WHERE id = $1`,
        [t.id, verdict.state, verdict.reason, JSON.stringify(verdict.candidates)]);

      if (verdict.state !== 'internal') {
        await emit(c, { type: 'payment.received', transferId: t.id,
          payload: { tx_hash: t.tx_hash, from: t.from_address, to: t.to_address, value: String(t.value),
                     token: t.token, block_number: String(t.block_number) } });
      }

      if (verdict.apply) {
        await applyMatch(c, { transfer: t, expectedPaymentId: verdict.apply.id,
          amount: t.value, confidence: 'exact_known_sender', by: 'matcher' });
      } else if (verdict.state === 'needs_review') {
        await emit(c, { type: 'payment.needs_review', transferId: t.id,
          payload: { reason: verdict.reason, tx_hash: t.tx_hash, from: t.from_address,
                     value: String(t.value), candidates: verdict.candidates } });
      }

      results.push({ transferId: String(t.id), txHash: t.tx_hash, state: verdict.state, reason: verdict.reason,
                     candidates: verdict.candidates.length });
      return false;
    });
    if (done || results.length >= limit) break;
  }
  return results;
}

/**
 * Resolve a review item. The one place the system mutates on human instruction.
 * `linkSender` is the learning loop: link this sender to the customer and an
 * identical future transfer auto-matches.
 */
/**
 * Review writes are the only mutations the dashboard can perform, and the
 * public deployment has no authentication in front of them. So the write path
 * is an explicit opt-in rather than something trusted by default: unset means
 * denied, which makes a new or misconfigured deployment read-only by accident
 * rather than writable by accident.
 *
 * Local work -- the CLI, the drills -- opts in through .env.
 */
export function reviewWritesEnabled() {
  return process.env.RETAINER_ENABLE_REVIEW_WRITES === 'true';
}

export const REVIEW_WRITES_DISABLED =
  'Review actions are disabled in this deployment. The matching engine still classifies transfers; only the human resolution path is turned off.';

export async function resolveReview({ transferId, action, expectedPaymentId, amount, linkSender, by = 'review:operator' }) {
  if (!reviewWritesEnabled()) throw new Error(REVIEW_WRITES_DISABLED);
  return tx(async (c) => {
    const t = (await q(c, `SELECT * FROM incoming_transfers WHERE id = $1 FOR UPDATE`, [transferId]))[0];
    if (!t) throw new Error(`transfer ${transferId} not found`);
    if (!['needs_review', 'resolved'].includes(t.match_state)) {
      throw new Error(`transfer ${transferId} is ${t.match_state}, not reviewable`);
    }

    if (linkSender) {
      await c.query(
        `INSERT INTO customer_addresses (customer_id, chain_id, address, note)
         VALUES ($1,$2,$3,$4) ON CONFLICT (chain_id, address) DO NOTHING`,
        [linkSender, t.chain_id, t.from_address, `linked during review of transfer ${t.id}`]);
      await audit(c, { actor: by, event: 'review.sender_linked', txHash: t.tx_hash,
        detail: { customerId: String(linkSender), address: t.from_address } });
    }

    if (action === 'ignore') {
      await c.query(`UPDATE incoming_transfers SET match_state='ignored', resolved_at=now(), resolved_by=$2 WHERE id=$1`, [t.id, by]);
      await audit(c, { actor: by, event: 'review.ignored', txHash: t.tx_hash, detail: { reason: t.match_reason } });
      return { transferId: String(t.id), action: 'ignore' };
    }

    if (action !== 'apply') throw new Error(`unknown action: ${action}`);
    const out = await applyMatch(c, { transfer: t, expectedPaymentId,
      amount: amount ?? t.value, confidence: 'manual', by });
    await c.query(`UPDATE incoming_transfers SET match_state='resolved', resolved_at=now(), resolved_by=$2 WHERE id=$1`, [t.id, by]);
    return { transferId: String(t.id), action: 'apply', ...out };
  });
}
