import { publicClient, config } from '@retainer/chain';
import { query, tx, audit } from '@retainer/db';
import { syncNonce } from './nonce.js';
import { awaitReceipt } from './charger.js';
import { assertLease } from './lease.js';

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
 *     already consumed -> judged at ONE block B: if our transaction left no charge event
 *                         up to B, something else took the nonce and this attempt is dead.
 *                         If it did, it landed (the receipt read was merely early).
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

  // Everything that decides "dead" is read at one block. The public RPC is load-balanced:
  // an unpinned receipt read can come from a node behind the one that reported the nonce
  // spent, which once made a landed charge look dead -- and a dead attempt is retried.
  // A node that does not have block B errors rather than answering stale.
  const B = await client.getBlockNumber();
  const nonceAtB = await client.getTransactionCount({ address: cfg.executor, blockNumber: B });

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

    // No receipt seen. Is the nonce still available to us?
    if (Number(a.nonce) < nonceAtB) {
      let landed;
      try { landed = await spentByBlock(client, cfg, a, B); }
      catch (e) {
        results.push({ attemptId: a.id, txHash: a.tx_hash, action: 'undetermined', reason: String(e?.shortMessage ?? e?.message ?? e).slice(0, 120) });
        continue;   // cannot tell at B yet: decide nothing, try next tick
      }
      if (landed) {
        results.push({ attemptId: a.id, txHash: a.tx_hash, action: 'found-by-logs' });
        await awaitReceipt({
          row: { id: a.charge_id, permission_id: a.permission_id, attempts: 0, executor: cfg.executor },
          attemptId: a.id, txHash: a.tx_hash, amount: BigInt(a.amount),
        });
        continue;
      }
      // Consumed by a different transaction, and ours moved nothing up to B -- it can never land now.
      await tx(async (c) => {
        await assertLease(c);
        await c.query(`UPDATE charge_attempts SET state='superseded', resolved_at=now() WHERE id=$1`, [a.id]);
        await c.query(`UPDATE charges SET state='failed_retryable', next_attempt_at=now(), updated_at=now()
                        WHERE id=$1 AND state='in_flight'`, [a.charge_id]);
        await audit(c, { actor: 'system', event: 'recovery.superseded',
          permissionId: a.permission_id, chargeId: a.charge_id, txHash: a.tx_hash,
          detail: { nonce: a.nonce, nonceAtBlock: nonceAtB, block: B.toString() } });
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
      await assertLease(c);
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

/**
 * Did this attempt's transaction move money, judged only from the chain up to block B?
 *
 * A successful charge always emits the manager's SpendPermissionUsed and the router's
 * SpendRouted; a reverted one emits nothing and moves nothing. So "no log from our
 * transaction hash up to B" means nothing was taken. Every range ends at B, so a node
 * without B throws instead of answering stale -- the caller then decides nothing.
 * The window starts a little before the attempt was signed (Base: ~2 s blocks).
 */
export async function spentByBlock(client, cfg, attempt, B) {
  const ageBlocks = BigInt(Math.ceil((Date.now() - new Date(attempt.signed_at).getTime()) / 2000)) + 150n;
  const want = attempt.tx_hash.toLowerCase();
  for (let lo = B > ageBlocks ? B - ageBlocks : 0n; lo <= B; lo += 900n) {
    const hi = lo + 899n > B ? B : lo + 899n;
    const logs = await client.getLogs({ address: [cfg.manager, cfg.router], fromBlock: lo, toBlock: hi });
    if (logs.some((l) => l.transactionHash?.toLowerCase() === want)) return true;
  }
  return false;
}
