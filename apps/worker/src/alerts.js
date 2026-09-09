import { createHmac, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { query, tx } from '@retainer/db';

/**
 * Alert delivery. Webhook is the primitive -- signed, retried, idempotent --
 * so a merchant can route it anywhere, Slack included. Email is a second
 * channel over the same retry loop rather than a parallel system.
 *
 * No paid service this phase: email goes through a narrow transport interface
 * whose default writes to a file. Wiring Resend or SMTP is implementing one
 * function and setting one env var -- see `transports` below.
 */

// Backoff shaped like the charge engine's, rather than a second policy.
const BACKOFF_SECONDS = [60, 300, 1500, 7200, 21600, 86400];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/* ------------------------------------------------------------- signing */

/**
 * `Retainer-Signature: t=<unix>,v1=<hex>` over `${t}.${body}`.
 * The timestamp is inside the signed material, so a captured delivery cannot
 * be replayed later.
 */
export function signPayload(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { header: `t=${timestamp},v1=${v1}`, timestamp, v1 };
}

/** Verification, exported so a receiver (and our tests) can use the same code. */
export function verifySignature(secret, body, header, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const t = header?.match(/t=(\d+)/)?.[1];
  const v1 = header?.match(/v1=([0-9a-f]+)/)?.[1];
  if (!t || !v1) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(t)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ---------------------------------------------------------- transports */

/**
 * The email transport boundary. One function, one shape:
 *   async ({ to, subject, text }) => { transport: string }
 * Adding Resend or SMTP means adding one entry here and setting
 * ALERT_EMAIL_TRANSPORT -- no caller changes.
 */
export const transports = {
  file: async ({ to, subject, text }) => {
    const path = process.env.ALERT_EMAIL_FILE ?? '/tmp/retainer-emails.log';
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${'='.repeat(72)}\nTo: ${to}\nSubject: ${subject}\nDate: ${new Date().toISOString()}\n\n${text}\n`);
    return { transport: 'file' };
  },
  console: async ({ to, subject, text }) => {
    console.log(JSON.stringify({ event: 'email', to, subject, text }));
    return { transport: 'console' };
  },
};

export const emailTransport = () => transports[process.env.ALERT_EMAIL_TRANSPORT ?? 'file'] ?? transports.file;

/* ------------------------------------------------------------- content */

const usdc = (v) => (Number(v) / 1_000_000).toFixed(6);

/** Plain-text email bodies. Deliberately factual; no marketing voice. */
export function renderEmail(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    case 'payment.overdue':
      return { subject: `Payment overdue — ${usdc(p.outstanding)} USDC outstanding`,
        text: `An expected payment is overdue.\n\nExpected payment: ${event.expected_payment_id}\nCustomer: ${p.customer_id}\nDue: ${p.due_date}\nExpected: ${usdc(p.amount_expected)} USDC\nSettled: ${usdc(p.amount_settled)} USDC\nOutstanding: ${usdc(p.outstanding)} USDC\nFulfilment: ${p.fulfilment}\n` };
    case 'payment.needs_review':
      return { subject: `Payment needs review — ${p.reason}`,
        text: `An incoming transfer could not be matched unambiguously, so it was not matched at all.\n\nReason: ${p.reason}\nTransaction: ${p.tx_hash}\nFrom: ${p.from}\nValue: ${usdc(p.value)} USDC\nCandidates: ${(p.candidates ?? []).length}\n\nResolve it in the dashboard review queue.\n` };
    case 'payment.paid':
      return { subject: `Payment settled — ${usdc(p.amount_settled)} USDC`,
        text: `Expected payment ${event.expected_payment_id} is fully settled, confirmed on-chain.\n\nCustomer: ${p.customer_id}\nAmount: ${usdc(p.amount_settled)} USDC\nVia: ${p.via}\n${p.tx_hash ? `Transaction: ${p.tx_hash}\n` : ''}` };
    case 'payment.matched':
      return { subject: `Payment matched — ${usdc(p.amount_applied)} USDC`,
        text: `A transfer was applied to expected payment ${event.expected_payment_id}.\n\nConfidence: ${p.confidence}\nMatched by: ${p.matched_by}\nApplied: ${usdc(p.amount_applied)} USDC\nSurplus: ${usdc(p.surplus)} USDC\nTransaction: ${p.tx_hash}\n` };
    case 'payment.received':
      return { subject: `Transfer received — ${usdc(p.value)} USDC`,
        text: `An incoming transfer was indexed.\n\nTransaction: ${p.tx_hash}\nFrom: ${p.from}\nTo: ${p.to}\nValue: ${usdc(p.value)} USDC\n` };
    case 'charge.failed':
      return { subject: `Charge failed — ${p.mode}`,
        text: `A pull charge failed and was classified from chain state before any gas was spent.\n\nCharge: ${event.charge_id}\nMode: ${p.mode}\nDisposition: ${p.disposition}\nDetail: ${p.detail}\nNext attempt: ${p.next_attempt_at ?? 'none — terminal'}\n` };
    default:
      return { subject: `Retainer event — ${event.type}`, text: JSON.stringify(event.payload, null, 2) };
  }
}

/* ------------------------------------------------------------ delivery */

async function attempt(delivery, event) {
  const body = JSON.stringify({
    id: event.id, type: event.type, occurred_at: event.occurred_at,
    expected_payment_id: event.expected_payment_id, charge_id: event.charge_id,
    transfer_id: event.transfer_id, data: event.payload,
  });

  if (delivery.channel === 'webhook') {
    const { header } = signPayload(delivery.secret ?? '', body);
    const res = await fetch(delivery.target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'retainer-signature': header,
        // Receivers dedupe on this: the same event is never a second payment.
        'retainer-event-id': event.id,
        'retainer-event-type': event.type,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return { status: res.status, transport: 'https' };
  }

  const { subject, text } = renderEmail(event);
  const out = await emailTransport()({ to: delivery.target, subject, text });
  return { status: null, transport: out.transport };
}

/** Deliver queued alerts. Claims with SKIP LOCKED, like every other queue here. */
export async function deliverAlerts({ limit = 25 } = {}) {
  const results = [];
  for (let i = 0; i < limit; i++) {
    const claimed = await tx(async (c) => {
      const { rows } = await c.query(`
        SELECT d.*, e.type, e.occurred_at, e.payload, e.expected_payment_id, e.charge_id, e.transfer_id,
               dest.secret
          FROM deliveries d
          JOIN events e ON e.id = d.event_id
          JOIN alert_destinations dest ON dest.id = d.destination_id
         WHERE d.state IN ('pending','failed') AND d.next_attempt_at <= now()
         ORDER BY d.next_attempt_at
           FOR UPDATE OF d SKIP LOCKED LIMIT 1`);
      if (!rows.length) return null;
      // Reserve it so a concurrent worker cannot claim the same delivery.
      await c.query(`UPDATE deliveries SET attempts = attempts + 1, next_attempt_at = now() + interval '1 hour' WHERE id = $1`, [rows[0].id]);
      return rows[0];
    });
    if (!claimed) break;

    const event = { id: claimed.event_id, type: claimed.type, occurred_at: claimed.occurred_at,
      payload: claimed.payload, expected_payment_id: claimed.expected_payment_id,
      charge_id: claimed.charge_id, transfer_id: claimed.transfer_id };

    try {
      const out = await attempt(claimed, event);
      await query(
        `UPDATE deliveries SET state='delivered', last_status=$2, transport=$3, delivered_at=now(), last_error=NULL WHERE id=$1`,
        [claimed.id, out.status, out.transport]);
      results.push({ id: String(claimed.id), type: claimed.type, channel: claimed.channel, state: 'delivered', transport: out.transport });
    } catch (e) {
      const n = Number(claimed.attempts) + 1;
      const dead = n >= MAX_ATTEMPTS;
      const backoff = BACKOFF_SECONDS[Math.min(n, BACKOFF_SECONDS.length - 1)];
      await query(
        `UPDATE deliveries SET state=$2, last_status=$3, last_error=$4, next_attempt_at = now() + make_interval(secs => $5) WHERE id=$1`,
        [claimed.id, dead ? 'dead' : 'failed', e.status ?? null, String(e.message ?? e).slice(0, 500), dead ? 0 : backoff]);
      results.push({ id: String(claimed.id), type: claimed.type, channel: claimed.channel, state: dead ? 'dead' : 'failed', error: String(e.message ?? e).slice(0, 120) });
    }
  }
  return results;
}

export async function addDestination({ channel, target, secret = null, eventTypes = null }) {
  const { rows } = await query(
    `INSERT INTO alert_destinations (channel, target, secret, event_types) VALUES ($1,$2,$3,$4)
     ON CONFLICT (channel, target) DO UPDATE SET active = true, secret = COALESCE($3, alert_destinations.secret)
     RETURNING id, channel, target, active`, [channel, target, secret, eventTypes]);
  return rows[0];
}
