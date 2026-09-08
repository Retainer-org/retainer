import { publicClient, config } from '@retainer/chain';
import { query, tx, audit } from '@retainer/db';
import { syncNonce } from './nonce.js';
import { awaitReceipt } from './charger.js';

/**
 * Resolve every attempt left open by a previous process.
 *
 * This is the path the whole sign-before-persist-before-broadcast design exists
 * to make safe. An attempt in 'signed' or 'broadcast' may or may not have been
 * broadcast, and may or may not have landed. We can always tell, because the
 * transaction hash was persisted before the broadcast:
 *
 *   receipt found      -> it landed. Record the outcome. Never re-send.
 *   no receipt, nonce
 *     already consumed -> something else took the nonce; this attempt is dead.
 *   no receipt, nonce
 *     still free       -> re-broadcast the IDENTICAL raw transaction. Same
 *                         nonce, same hash, so at most one can ever land.
 */
export async function recoverOpenAttempts() {
  const cfg = config();
  const client = publicClient();
  const results = [];

  await tx(async (c) => { await syncNonce(c, cfg.executor); });

  const { rows } = await query(`
    SELECT a.*, ch.permission_id, ch.state AS charge_state
      FROM charge_attempts a
      JOIN charges ch ON ch.id = a.charge_id
     WHERE a.state IN ('signed','broadcast')
     ORDER BY a.id`);

  if (!rows.length) return results;

  const chainNonce = await client.getTransactionCount({ address: cfg.executor, blockTag: 'latest' });

  for (const a of rows) {
    let receipt = null;
    try { receipt = await client.getTransactionReceipt({ hash: a.tx_hash }); } catch { receipt = null; }

    if (receipt) {
      results.push({ attemptId: a.id, txHash: a.tx_hash, action: 'found-onchain', status: receipt.status });
      await tx(async (c) => {
        await audit(c, { actor: 'system', event: 'recovery.found_onchain',
          permissionId: a.permission_id, chargeId: a.charge_id, txHash: a.tx_hash,
          detail: { status: receipt.status, block: receipt.blockNumber.toString() } });
      });
      await awaitReceipt({
        row: { id: a.charge_id, permission_id: a.permission_id, attempts: 0, executor: cfg.executor },
        attemptId: a.id, txHash: a.tx_hash, amount: BigInt(a.amount),
      });
      continue;
    }

    // Not mined. Is the nonce still available to us?
    if (Number(a.nonce) < chainNonce) {
      // Consumed by a different transaction -- ours can never land now.
      await tx(async (c) => {
        await c.query(`UPDATE charge_attempts SET state='superseded', resolved_at=now() WHERE id=$1`, [a.id]);
        await c.query(`UPDATE charges SET state='failed_retryable', next_attempt_at=now(), updated_at=now()
                        WHERE id=$1 AND state='in_flight'`, [a.charge_id]);
        await audit(c, { actor: 'system', event: 'recovery.superseded',
          permissionId: a.permission_id, chargeId: a.charge_id, txHash: a.tx_hash,
          detail: { nonce: a.nonce, chainNonce } });
      });
      results.push({ attemptId: a.id, txHash: a.tx_hash, action: 'superseded' });
      continue;
    }

    // Nonce still free: re-broadcast the identical bytes.
    let rebroadcast = 'sent';
    try {
      await client.sendRawTransaction({ serializedTransaction: a.raw_tx });
    } catch (e) {
      const m = (e?.details ?? e?.shortMessage ?? e?.message ?? '').toLowerCase();
      rebroadcast = (m.includes('already known') || m.includes('already exists')) ? 'already-in-mempool' : `error: ${m}`;
    }
    await tx(async (c) => {
      await c.query(`UPDATE charge_attempts SET state='broadcast', broadcast_at=COALESCE(broadcast_at, now()) WHERE id=$1`, [a.id]);
      await audit(c, { actor: 'system', event: 'recovery.rebroadcast',
        permissionId: a.permission_id, chargeId: a.charge_id, txHash: a.tx_hash,
        detail: { nonce: a.nonce, result: rebroadcast } });
    });
    results.push({ attemptId: a.id, txHash: a.tx_hash, action: 'rebroadcast', result: rebroadcast });

    await awaitReceipt({
      row: { id: a.charge_id, permission_id: a.permission_id, attempts: 0, executor: cfg.executor },
      attemptId: a.id, txHash: a.tx_hash, amount: BigInt(a.amount),
    });
  }
  return results;
}
