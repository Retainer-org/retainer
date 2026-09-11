import { NextResponse } from 'next/server';
import { isHex, size, toEventSelector } from 'viem';
import { spendPermissionManagerAbi, toStruct, publicClient, config } from '@retainer/chain';
import { query } from '@retainer/db';
import { markRevoked } from '../../../../../cli/src/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** keccak256 of the manager's revocation event, with the struct expanded as the ABI requires. */
const REVOKED = toEventSelector(
  'SpendPermissionRevoked(bytes32,(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes))');

const refuse = (status, code, error) => NextResponse.json({ code, error }, { status });

/**
 * The customer's page waits for the receipt on its own connection before calling here, and
 * the public RPC is load-balanced: our node can be a block or two behind theirs. A read that
 * is merely early must not be recorded as a refusal, so each one is retried briefly.
 */
async function settle(read, done, tries = 6) {
  let v = null;
  for (let i = 0; i < tries; i++) {
    v = await read().catch(() => null);
    if (done(v)) return v;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return v;
}

/**
 * Record a revocation the customer made from their own wallet.
 *
 * Nothing indexes SpendPermissionRevoked, and a customer's revoke never passes
 * through our server -- so without this, our records would call the permission
 * active until a charge failed against it. This endpoint writes nothing on the
 * caller's say-so: it requires the transaction to have succeeded, to contain the
 * manager's revocation event for exactly this permission, and the manager to
 * report the permission revoked at that transaction's block.
 */
export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return refuse(400, 'bad_request', 'body is not JSON'); }
  const { permissionHash, txHash } = body;
  if (!isHex(permissionHash ?? '') || size(permissionHash) !== 32) return refuse(400, 'bad_request', 'permissionHash must be 32 bytes');
  if (!isHex(txHash ?? '') || size(txHash) !== 32) return refuse(400, 'bad_request', 'txHash must be 32 bytes');

  const row = (await query('SELECT * FROM permissions WHERE permission_hash = $1', [permissionHash])).rows[0];
  if (!row) return refuse(404, 'not_found', 'no such permission');
  if (row.revoked_at) return NextResponse.json({ permissionId: String(row.id), alreadyRecorded: true, revokeTx: row.revoked_tx_hash });

  const pub = publicClient();
  const manager = config().manager.toLowerCase();
  const receipt = await settle(() => pub.getTransactionReceipt({ hash: txHash }), (r) => !!r);
  if (!receipt || receipt.status !== 'success') return refuse(400, 'not_confirmed', 'that transaction has not succeeded on-chain');

  const revokedHere = receipt.logs.some((l) =>
    l.address.toLowerCase() === manager && l.topics[0] === REVOKED && l.topics[1]?.toLowerCase() === permissionHash.toLowerCase());
  if (!revokedHere) return refuse(400, 'not_the_revoking_tx', 'that transaction did not revoke this permission');

  const struct = toStruct({ account: row.account, spender: row.spender, token: row.token, allowance: row.allowance,
    period: row.period_seconds, start: row.start_ts, end: row.end_ts, salt: row.salt, extraData: row.extra_data });
  // Read at the revoking block: a node that has the receipt has that block. A revocation cannot be undone,
  // so revoked there means revoked now.
  const revoked = await settle(() => pub.readContract({ address: config().manager, abi: spendPermissionManagerAbi,
    functionName: 'isRevoked', args: [struct], blockNumber: receipt.blockNumber }), (v) => v === true);
  if (!revoked) return refuse(409, 'not_revoked', 'the manager does not report this permission as revoked');

  const id = await markRevoked(permissionHash, txHash);
  return NextResponse.json({ permissionId: String(id), revoked: true, revokeTx: txHash });
}
