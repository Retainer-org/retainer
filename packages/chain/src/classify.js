import { spendPermissionManagerAbi, spendRouterAbi, erc20Abi } from './abis.js';
import { extractSelector, modeFromSelector, selectorName } from './errors.js';
import { toStruct, periodFor } from './permission.js';

/**
 * Classify a charge BEFORE broadcasting, by reading chain state.
 *
 * Rationale: a reverted charge consumes no allowance (the manager's accounting
 * and the token transfer are one atomic transaction), so retrying is free
 * against the cap -- but it still burns gas. Pre-flighting means we almost
 * never broadcast a transaction we expect to revert, which bounds the retry
 * budget by gas rather than by allowance.
 *
 * Returns { ok: true, ... } or { ok: false, mode, detail, retryAt }.
 */
export async function classify({ client, permission, amount, manager, router, now }) {
  const s = toStruct(permission);
  const nowSec = now ?? Math.floor(Date.now() / 1000);

  // 1. REVOKED -- terminal. Checked first: a revoked permission is revoked
  //    regardless of anything else, and revocation is irreversible on-chain.
  const revoked = await client.readContract({
    address: manager, abi: spendPermissionManagerAbi, functionName: 'isRevoked', args: [s],
  });
  if (revoked) return { ok: false, mode: 'REVOKED', detail: 'isRevoked() == true', retryAt: null };

  // 2/3. EXPIRED / NOT_STARTED -- from the permission's own window.
  const per = periodFor(permission, nowSec);
  if (per.state === 'EXPIRED') {
    return { ok: false, mode: 'EXPIRED', detail: `end=${permission.end} <= now=${nowSec}`, retryAt: null };
  }
  if (per.state === 'NOT_STARTED') {
    return { ok: false, mode: 'NOT_STARTED', detail: `start=${permission.start} > now=${nowSec}`,
             retryAt: Number(permission.start) };
  }

  // 4. NOT_APPROVED -- signed but never registered on-chain. Recoverable by
  //    submitting approveWithSignature, which we can do gaslessly for the user.
  const approved = await client.readContract({
    address: manager, abi: spendPermissionManagerAbi, functionName: 'isApproved', args: [s],
  });
  if (!approved) {
    return { ok: false, mode: 'NOT_APPROVED', detail: 'isApproved() == false', retryAt: null };
  }

  // 5. ALLOWANCE_EXHAUSTED -- allowance resets to zero at each period boundary
  //    and unused allowance does NOT carry forward, so the only cure is waiting.
  const cur = await client.readContract({
    address: manager, abi: spendPermissionManagerAbi, functionName: 'getCurrentPeriod', args: [s],
  });
  const remaining = BigInt(permission.allowance) - BigInt(cur.spend);
  if (BigInt(amount) > remaining) {
    return { ok: false, mode: 'ALLOWANCE_EXHAUSTED',
             detail: `want=${amount} remaining=${remaining} periodEnd=${cur.end}`,
             retryAt: Number(cur.end) };
  }

  // 6. INSUFFICIENT_BALANCE -- the only mode with no custom error of its own;
  //    Circle's USDC reverts with a plain string. Must be caught by state.
  const balance = await client.readContract({
    address: permission.token, abi: erc20Abi, functionName: 'balanceOf', args: [s.account],
  });
  if (balance < BigInt(amount)) {
    return { ok: false, mode: 'INSUFFICIENT_BALANCE',
             detail: `balance=${balance} want=${amount}`, retryAt: null };
  }

  // Final gate: simulate the exact call we are about to broadcast.
  try {
    await client.simulateContract({
      address: router, abi: spendRouterAbi, functionName: 'spendAndRoute',
      args: [s, BigInt(amount)], account: (await import('viem')).getAddress(permission.executor),
    });
  } catch (err) {
    const sel = extractSelector(err);
    let mode = modeFromSelector(sel, err?.shortMessage ?? err?.message ?? '');
    if (mode === null) mode = revoked ? 'REVOKED' : 'NOT_APPROVED'; // UnauthorizedSpendPermission
    return { ok: false, mode: mode ?? 'UNKNOWN',
             detail: `simulation reverted: ${selectorName(sel) ?? sel ?? 'undecodable'}`, retryAt: null };
  }

  return { ok: true, periodStart: per.periodStart, periodEnd: per.periodEnd, remaining };
}
