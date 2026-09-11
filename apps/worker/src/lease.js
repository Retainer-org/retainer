import { randomUUID } from 'node:crypto';
import { query } from '@retainer/db';

/**
 * One worker at a time.
 *
 * Railway starts a new deployment before it stops the old one (about 3.7 s observed), and a
 * crashed worker is restarted while its predecessor's claim may still be live. Two workers
 * must never both recover or charge: recovery acts on every open attempt, including one the
 * other worker is still broadcasting. So a worker ticks only while it holds this lease and
 * renews it on a heartbeat -- and every transaction that could create or retire an attempt
 * re-checks it inside itself (assertLease), so a worker that has silently lost the lease
 * cannot act on the belief that it still holds it.
 *
 * A worker stopped by SIGTERM releases the lease, and the next one starts at once. A worker
 * that dies without releasing it blocks its successor for at most LEASE_TTL_SECONDS.
 */
export const LEASE_TTL_SECONDS = 30;
export const WORKER_LEASE = 'worker';

let current = null;   // { name, holder, expiresAt } -- the lease this process believes it holds

export class LeaseError extends Error {
  constructor(message) { super(message); this.name = 'LeaseError'; }
}

export function newHolderId() {
  return `${process.env.RAILWAY_DEPLOYMENT_ID?.slice(0, 8) ?? 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/** Take the lease if it is free or lapsed, or renew it if `holder` already has it. True if held afterwards. */
export async function acquireLease(name, holder, ttlSeconds = LEASE_TTL_SECONDS) {
  const { rows } = await query(
    `INSERT INTO worker_lease (name, holder, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))
     ON CONFLICT (name) DO UPDATE
        SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at,
            acquired_at = CASE WHEN worker_lease.holder = EXCLUDED.holder THEN worker_lease.acquired_at ELSE now() END
      WHERE worker_lease.holder = EXCLUDED.holder OR worker_lease.expires_at < now()
     RETURNING expires_at`, [name, holder, ttlSeconds]);
  if (rows.length === 1) { current = { name, holder, expiresAt: new Date(rows[0].expires_at) }; return true; }
  if (current?.name === name && current.holder === holder) current = null;
  return false;
}

export async function releaseLease(name, holder) {
  await query('DELETE FROM worker_lease WHERE name = $1 AND holder = $2', [name, holder]);
  if (current?.name === name && current.holder === holder) current = null;
}

/** Who holds a lease right now (null when free or lapsed). For logs. */
export async function leaseHolder(name) {
  const { rows } = await query('SELECT holder FROM worker_lease WHERE name = $1 AND expires_at > now()', [name]);
  return rows[0]?.holder ?? null;
}

export function heldLease() { return current; }

/**
 * Inside a transaction: throw unless this process holds a live lease. Fails closed -- a
 * process that never took a lease cannot charge or retire an attempt at all.
 */
export async function assertLease(c) {
  if (!current) throw new LeaseError('this process holds no worker lease');
  const { rows } = await c.query(
    'SELECT holder, expires_at > now() AS live FROM worker_lease WHERE name = $1 FOR SHARE', [current.name]);
  if (!rows[0] || rows[0].holder !== current.holder || !rows[0].live) {
    throw new LeaseError(`lease "${current.name}" is not held by ${current.holder}`);
  }
}
