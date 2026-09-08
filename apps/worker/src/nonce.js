import { publicClient } from '@retainer/chain';

/**
 * Allocate the next nonce for the executor.
 *
 * MUST be called inside the same transaction that persists the signed attempt.
 * If that transaction rolls back, the nonce allocation rolls back with it, so
 * we never burn a nonce on a charge that was never signed.
 *
 * pg_advisory_xact_lock serialises all allocation across workers; the lock is
 * released automatically at COMMIT or ROLLBACK.
 */
export async function allocateNonce(c, executor) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [executor.toLowerCase()]);

  const { rows } = await c.query(
    'SELECT next_nonce FROM executor_nonces WHERE executor = $1 FOR UPDATE',
    [executor.toLowerCase()],
  );

  let next;
  if (rows.length === 0) {
    // First run: seed from chain.
    const chainNonce = await publicClient().getTransactionCount({ address: executor, blockTag: 'pending' });
    next = BigInt(chainNonce);
    await c.query('INSERT INTO executor_nonces (executor, next_nonce) VALUES ($1,$2)',
      [executor.toLowerCase(), (next + 1n).toString()]);
  } else {
    next = BigInt(rows[0].next_nonce);
    await c.query('UPDATE executor_nonces SET next_nonce = $2, updated_at = now() WHERE executor = $1',
      [executor.toLowerCase(), (next + 1n).toString()]);
  }
  return Number(next);
}

/**
 * Reconcile the stored nonce against chain on startup. Takes the max, so a
 * transaction we lost track of can never cause us to reuse its nonce.
 */
export async function syncNonce(c, executor) {
  const chainNonce = BigInt(await publicClient().getTransactionCount({ address: executor, blockTag: 'pending' }));
  const { rows } = await c.query('SELECT next_nonce FROM executor_nonces WHERE executor = $1', [executor.toLowerCase()]);
  const stored = rows.length ? BigInt(rows[0].next_nonce) : 0n;
  const next = chainNonce > stored ? chainNonce : stored;
  await c.query(
    `INSERT INTO executor_nonces (executor, next_nonce) VALUES ($1,$2)
     ON CONFLICT (executor) DO UPDATE SET next_nonce = $2, updated_at = now()`,
    [executor.toLowerCase(), next.toString()]);
  return { chainNonce: Number(chainNonce), stored: Number(stored), next: Number(next) };
}
