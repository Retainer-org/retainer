import { query } from '@retainer/db';

/**
 * The event log, and fan-out to alert destinations.
 *
 * Events are emitted inside the same database transaction as the state change
 * that caused them, so an event exists if and only if the thing happened.
 * Delivery is separate and retried; emission is not.
 */

export const EVENT_TYPES = [
  'payment.overdue',       // sweep moved an obligation past its due date
  'payment.received',      // an incoming transfer was indexed (not internal)
  'payment.matched',       // a transfer was attributed to an expected payment
  'payment.paid',          // an expected payment is now fully settled
  'payment.needs_review',  // the matcher declined to guess
  'charge.failed',         // a pull failed, carrying the classifier's own verdict
];

/**
 * Record an event and queue a delivery for every destination subscribed to it.
 * Must be called with a client inside an open transaction.
 */
export async function emit(c, { type, expectedPaymentId = null, chargeId = null, transferId = null, payload = {} }) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event type: ${type}`);

  const { rows } = await c.query(
    `INSERT INTO events (type, expected_payment_id, charge_id, transfer_id, payload)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, occurred_at`,
    [type, expectedPaymentId, chargeId, transferId, JSON.stringify(payload)]);
  const event = rows[0];

  // One delivery row per (event, destination). The UNIQUE constraint makes
  // fan-out idempotent even if emission is somehow retried.
  await c.query(
    `INSERT INTO deliveries (event_id, destination_id, channel, target)
     SELECT $1, d.id, d.channel, d.target
       FROM alert_destinations d
      WHERE d.active
        AND (d.event_types IS NULL OR $2 = ANY(d.event_types))
     ON CONFLICT (event_id, destination_id) DO NOTHING`,
    [event.id, type]);

  return event.id;
}

export async function recentEvents(limit = 50) {
  return (await query(
    `SELECT id, type, occurred_at, expected_payment_id, charge_id, transfer_id, payload
       FROM events ORDER BY occurred_at DESC, id DESC LIMIT $1`, [limit])).rows;
}
