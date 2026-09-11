import { NextResponse } from 'next/server';
import { config, erc20Abi, publicClient, spendPermissionManagerAbi, toStruct } from '@retainer/chain';
import { query } from '@retainer/db';
import { sessionAddress, SessionUnavailable } from '../../../../lib/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const refuse = (status, code, error) => NextResponse.json({ code, error }, { status });
const opt = (p) => p.then((v) => v, () => null);   // a chain read that fails reads as "unavailable", never as a guess

/**
 * The signed-in customer's permissions and the charges taken against them.
 *
 * The address comes from the session cookie and nowhere else: this route reads no query
 * parameter, so there is nothing to change to see another customer. State that only the
 * chain knows -- whether it is revoked, what has been spent this period, the smart account's
 * balance -- is read live; if the RPC fails it is returned as null and the page says so.
 */
export async function GET(req) {
  let address;
  try { address = sessionAddress(req); }
  catch (e) { if (e instanceof SessionUnavailable) return refuse(503, 'signin_unavailable', 'Sign-in is not configured on this deployment.'); throw e; }
  if (!address) return refuse(401, 'signed_out', 'Sign in to see your permissions.');

  const cfg = config();
  const pub = publicClient();
  const perms = (await query(
    `SELECT id, permission_hash, account, spender, token, allowance, period_seconds, start_ts, end_ts, salt, extra_data,
            recipient, approved_tx_hash, revoked_at, revoked_tx_hash, created_at,
            (SELECT l.merchant_name FROM billing_links l WHERE l.id = permissions.link_id) AS merchant_name
       FROM permissions WHERE lower(signer_eoa) = $1 ORDER BY id DESC LIMIT 50`, [address])).rows;
  const ids = perms.map((p) => p.id);
  const charges = ids.length ? (await query(
    `SELECT id, permission_id, amount, state::text AS state, last_failure::text AS last_failure, confirmed_tx_hash, confirmed_amount,
            confirmed_at, created_at, updated_at
       FROM charges WHERE permission_id = ANY($1::bigint[]) ORDER BY id DESC`, [ids])).rows : [];

  const now = Math.floor(Date.now() / 1000);
  const accounts = [...new Set(perms.map((p) => p.account.toLowerCase()))];
  const [balances, chain] = await Promise.all([
    Promise.all(accounts.map((a) => opt(pub.readContract({ address: cfg.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] })))),
    Promise.all(perms.map((p) => {
      const s = toStruct({ account: p.account, spender: p.spender, token: p.token, allowance: p.allowance, period: p.period_seconds,
        start: p.start_ts, end: p.end_ts, salt: p.salt, extraData: p.extra_data });
      const inWindow = now >= Number(p.start_ts) && now < Number(p.end_ts);
      return Promise.all([
        opt(pub.readContract({ address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'isRevoked', args: [s] })),
        inWindow ? opt(pub.readContract({ address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'getCurrentPeriod', args: [s] })) : Promise.resolve(null),
      ]);
    })),
  ]);
  const balanceOf = Object.fromEntries(accounts.map((a, i) => [a, balances[i]]));

  const out = perms.map((p, i) => {
    const [revokedOnChain, period] = chain[i];
    const start = Number(p.start_ts), end = Number(p.end_ts);
    const state = p.revoked_at || revokedOnChain === true ? 'revoked' : now >= end ? 'expired' : now < start ? 'not_started' : 'active';
    const spent = period ? BigInt(period.spend ?? period[2]) : null;
    return {
      id: String(p.id), permissionHash: p.permission_hash, account: p.account, recipient: p.recipient, merchantName: p.merchant_name,
      allowance: String(p.allowance), period: Number(p.period_seconds), start, end, salt: String(p.salt), extraData: p.extra_data,
      spender: p.spender, token: p.token, state,
      revokedOnChain, revokeRecorded: !!p.revoked_at, approveTx: p.approved_tx_hash, revokeTx: p.revoked_tx_hash,
      thisPeriod: period && state === 'active'
        ? { start: Number(period.start ?? period[0]), end: Number(period.end ?? period[1]), spent: spent.toString(), remaining: (BigInt(p.allowance) - spent).toString() }
        : null,
      accountBalance: balanceOf[p.account.toLowerCase()] === null ? null : String(balanceOf[p.account.toLowerCase()]),
      charges: charges.filter((c) => String(c.permission_id) === String(p.id)).map((c) => ({
        id: String(c.id), amount: String(c.confirmed_amount ?? c.amount), state: c.state, failure: c.last_failure,
        txHash: c.confirmed_tx_hash, at: new Date(c.confirmed_at ?? c.updated_at ?? c.created_at).toISOString(),
      })),
    };
  });
  return NextResponse.json({ address, readAt: new Date().toISOString(), permissions: out });
}
