import { encodeFunctionData, getAddress } from 'viem';
import {
  classify, config, executorWallet, publicClient,
  spendRouterAbi, extractSelector, modeFromSelector, selectorName, toStruct, periodFor,
} from '@retainer/chain';
import { tx, audit } from '@retainer/db';
import { allocateNonce } from './nonce.js';

/** How a failure mode maps onto charge state and when (if ever) to try again. */
export function dispositionFor(mode, retryAt, attempts) {
  switch (mode) {
    // Terminal. The permission is gone; no amount of retrying brings it back.
    case 'REVOKED':
    case 'EXPIRED':
      return { state: 'failed_terminal', nextAttemptAt: null };

    // Retry inside the period with backoff. Free against the allowance -- a
    // reverted charge consumes none -- but it costs gas, so it is capped.
    case 'INSUFFICIENT_BALANCE': {
      if (attempts >= 8) return { state: 'failed_terminal', nextAttemptAt: null };
      const backoffSec = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
      return { state: 'failed_retryable', nextAttemptAt: new Date(Date.now() + backoffSec * 1000) };
    }

    // Deferred to a known future instant. Retrying before then is pure waste:
    // the allowance only resets at the period boundary and does not carry over.
    case 'ALLOWANCE_EXHAUSTED':
    case 'NOT_STARTED':
      return { state: 'failed_deferred', nextAttemptAt: retryAt ? new Date(retryAt * 1000) : new Date(Date.now() + 3600e3) };

    // Signed but never registered on-chain. Recoverable, but by submitting
    // approveWithSignature -- not by retrying the charge.
    case 'NOT_APPROVED':
      return { state: 'failed_deferred', nextAttemptAt: new Date(Date.now() + 300e3) };

    default:
      return { state: 'failed_retryable', nextAttemptAt: new Date(Date.now() + 300e3) };
  }
}

/** Claim one due charge. FOR UPDATE SKIP LOCKED so workers never collide. */
export async function claimCharge(onlyChargeId = null) {
  return tx(async (c) => {
    const { rows } = await c.query(`
      SELECT ch.*, p.permission_hash, p.account, p.spender, p.token, p.allowance,
             p.period_seconds, p.start_ts, p.end_ts, p.salt, p.extra_data,
             p.executor, p.recipient
        FROM charges ch
        JOIN permissions p ON p.id = ch.permission_id
       WHERE ch.state IN ('pending','failed_retryable','failed_deferred')
         AND ($1::bigint IS NULL OR ch.id = $1::bigint)
         AND ($1::bigint IS NOT NULL OR ch.next_attempt_at <= now())
       ORDER BY ch.next_attempt_at
         FOR UPDATE OF ch SKIP LOCKED
       LIMIT 1`, [onlyChargeId]);
    if (!rows.length) return null;
    const row = rows[0];
    await c.query(`UPDATE charges SET state='in_flight', attempts = attempts + 1, updated_at = now()
                   WHERE id = $1`, [row.id]);
    return row;
  });
}

function permissionFromRow(r) {
  return {
    account: r.account, spender: r.spender, token: r.token,
    allowance: r.allowance, period: r.period_seconds,
    start: r.start_ts, end: r.end_ts, salt: r.salt,
    extraData: r.extra_data, executor: r.executor, recipient: r.recipient,
  };
}

/**
 * Resolve the amount to charge. For 'usage' this is computed AT CHARGE TIME
 * from recorded usage, not fixed when the charge was enqueued -- which is the
 * whole point of metered billing.
 */
export async function resolveAmount(c, row) {
  if (row.amount_source !== 'usage') return { amount: BigInt(row.amount), note: null };
  const { rows } = await c.query(
    `SELECT COALESCE(SUM(units * unit_price), 0) AS total, COUNT(*) AS n
       FROM usage_records WHERE permission_id = $1 AND period_start = $2`,
    [row.permission_id, row.period_start]);
  const total = BigInt(rows[0].total);
  return { amount: total, note: `computed at charge time from ${rows[0].n} usage record(s) = ${total}` };
}

async function recordFailure(row, mode, detail, retryAt) {
  const d = dispositionFor(mode, retryAt, Number(row.attempts) + 1);
  await tx(async (c) => {
    await c.query(
      `UPDATE charges SET state=$2, last_failure=$3, failure_detail=$4,
              next_attempt_at = COALESCE($5, next_attempt_at), updated_at = now()
         WHERE id = $1`,
      [row.id, d.state, mode, detail, d.nextAttemptAt]);
    await audit(c, { actor: 'executor', event: `charge.failed.${mode}`,
      permissionId: row.permission_id, chargeId: row.id,
      detail: { mode, detail, disposition: d.state, nextAttemptAt: d.nextAttemptAt } });
  });
  return { outcome: 'failed', mode, detail, disposition: d.state };
}

/**
 * Attempt one charge.
 *
 * Ordering is the entire point of this function:
 *   sign locally -> PERSIST raw tx + hash + nonce -> COMMIT -> broadcast
 *
 * If the process dies between the commit and the broadcast, or between the
 * broadcast and the state update, recovery re-broadcasts the identical raw
 * transaction. Same nonce, same hash, so at most one can ever land.
 */
export async function attemptCharge(row, { crashAfterBroadcast = false, crashBeforeBroadcast = false } = {}) {
  const cfg = config();
  const client = publicClient();
  const wallet = executorWallet();
  const permission = permissionFromRow(row);

  // Amount first: a usage-based charge is computed now, not at enqueue time.
  const { amount, note } = await tx(async (c) => resolveAmount(c, row));
  if (amount <= 0n) {
    return recordFailure(row, 'UNKNOWN', 'resolved amount was zero', null);
  }
  if (note) {
    await tx(async (c) => {
      await c.query('UPDATE charges SET amount=$2, usage_note=$3, updated_at=now() WHERE id=$1',
        [row.id, amount.toString(), note]);
      await audit(c, { actor: 'executor', event: 'charge.amount.computed',
        permissionId: row.permission_id, chargeId: row.id, detail: { amount: amount.toString(), note } });
    });
  }

  // Pre-flight: classify from chain state before spending any gas.
  const verdict = await classify({
    client, permission, amount, manager: cfg.manager, router: cfg.router,
  });
  if (!verdict.ok) return recordFailure(row, verdict.mode, verdict.detail, verdict.retryAt);

  const s = toStruct(permission);
  const data = encodeFunctionData({ abi: spendRouterAbi, functionName: 'spendAndRoute', args: [s, amount] });

  // Fix gas parameters now so the signed transaction is fully deterministic and
  // can be re-broadcast byte-for-byte on recovery.
  const fees = await client.estimateFeesPerGas();
  let gas;
  try {
    gas = await client.estimateGas({ account: getAddress(permission.executor), to: cfg.router, data });
    gas = (gas * 130n) / 100n;
  } catch {
    gas = 400000n;
  }

  // --- sign, persist, COMMIT -------------------------------------------------
  const { attemptId, rawTx, txHash, nonce } = await tx(async (c) => {
    const nonce = await allocateNonce(c, permission.executor);
    const rawTx = await wallet.signTransaction({
      to: getAddress(cfg.router), data, nonce, gas,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      chainId: cfg.chainId, type: 'eip1559',
    });
    const { keccak256 } = await import('viem');
    const txHash = keccak256(rawTx);
    const { rows } = await c.query(
      `INSERT INTO charge_attempts (charge_id, nonce, tx_hash, raw_tx, amount, state)
       VALUES ($1,$2,$3,$4,$5,'signed') RETURNING id`,
      [row.id, nonce, txHash, rawTx, amount.toString()]);
    await audit(c, { actor: 'executor', event: 'charge.signed',
      permissionId: row.permission_id, chargeId: row.id, txHash,
      detail: { nonce, amount: amount.toString(), gas: gas.toString() } });
    return { attemptId: rows[0].id, rawTx, txHash, nonce };
  });
  // --- raw transaction is now durable. Only now may we broadcast. -----------

  if (crashBeforeBroadcast) {
    // Fault injection for the superseded branch. The attempt is durable and
    // holds nonce N; nothing has been broadcast. Exit hard.
    console.log(JSON.stringify({ event: 'CRASH_INJECTED_BEFORE_BROADCAST', chargeId: row.id, attemptId, txHash, nonce }));
    process.exit(137);
  }

  let sendErr = null;
  try {
    await client.sendRawTransaction({ serializedTransaction: rawTx });
  } catch (e) {
    // "already known" / "nonce too low" mean it is already out there: not an error.
    const m = (e?.details ?? e?.shortMessage ?? e?.message ?? '').toLowerCase();
    if (!m.includes('already known') && !m.includes('already exists') && !m.includes('nonce too low')) sendErr = e;
  }

  if (crashAfterBroadcast) {
    // Deliberate fault injection for the crash-recovery drill. The broadcast has
    // happened; the row still says 'signed'. Exit hard, no cleanup, no handlers.
    console.log(JSON.stringify({ event: 'CRASH_INJECTED', chargeId: row.id, attemptId, txHash, nonce }));
    process.exit(137);
  }

  if (sendErr) {
    await tx(async (c) => {
      await c.query(`UPDATE charge_attempts SET state='abandoned', resolved_at=now() WHERE id=$1`, [attemptId]);
      await audit(c, { actor: 'executor', event: 'charge.broadcast.failed',
        permissionId: row.permission_id, chargeId: row.id, txHash,
        detail: { error: String(sendErr?.shortMessage ?? sendErr?.message ?? sendErr) } });
    });
    return recordFailure(row, 'UNKNOWN', `broadcast failed: ${sendErr?.shortMessage ?? sendErr}`, null);
  }

  await tx(async (c) => {
    await c.query(`UPDATE charge_attempts SET state='broadcast', broadcast_at=now() WHERE id=$1`, [attemptId]);
    await audit(c, { actor: 'executor', event: 'charge.broadcast',
      permissionId: row.permission_id, chargeId: row.id, txHash, detail: { nonce } });
  });

  return awaitReceipt({ row, attemptId, txHash, amount });
}

/** Wait for inclusion and record the on-chain outcome (not the same as "paid"). */
export async function awaitReceipt({ row, attemptId, txHash, amount }) {
  const client = publicClient();
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000, confirmations: 1 });
  } catch {
    return { outcome: 'pending', txHash, note: 'receipt not seen within timeout; recovery will resolve' };
  }

  if (receipt.status === 'success') {
    await tx(async (c) => {
      await c.query(
        `UPDATE charge_attempts SET state='mined_success', gas_used=$2, effective_gas_price=$3,
                block_number=$4, resolved_at=now() WHERE id=$1`,
        [attemptId, receipt.gasUsed.toString(), receipt.effectiveGasPrice.toString(), receipt.blockNumber.toString()]);
      await audit(c, { actor: 'executor', event: 'charge.mined',
        permissionId: row.permission_id, chargeId: row.id, txHash,
        detail: { gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() } });
    });
    // Deliberately NOT marked paid here. Only the reconciler, from confirmed
    // events, may write state='confirmed'.
    return { outcome: 'mined', txHash, amount: amount.toString(), block: Number(receipt.blockNumber) };
  }

  // Reverted: decode the selector for the record, then classify from state.
  let selector = null, mode = 'UNKNOWN';
  try {
    await client.call({ to: receipt.to, data: (await client.getTransaction({ hash: txHash })).input,
      account: row.executor, blockNumber: receipt.blockNumber });
  } catch (e) {
    selector = extractSelector(e);
    mode = modeFromSelector(selector, e?.shortMessage ?? e?.message ?? '') ?? 'UNKNOWN';
  }
  await tx(async (c) => {
    await c.query(
      `UPDATE charge_attempts SET state='mined_reverted', revert_selector=$2, failure_mode=$3,
              gas_used=$4, block_number=$5, resolved_at=now() WHERE id=$1`,
      [attemptId, selector, mode, receipt.gasUsed.toString(), receipt.blockNumber.toString()]);
  });
  return recordFailure(row, mode, `reverted on-chain: ${selectorName(selector) ?? selector ?? 'undecodable'}`, null);
}
