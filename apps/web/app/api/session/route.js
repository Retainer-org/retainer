import { NextResponse } from 'next/server';
import { isHex, recoverTypedDataAddress, size } from 'viem';
import { checkOwner, config, publicClient, signInTypedData } from '@retainer/chain';
import { query } from '@retainer/db';
import { allowedOrigins, COOKIE, cookieOptions, issueCookie, sessionAddress, SessionUnavailable } from '../../../lib/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const refuse = (status, code, error) => NextResponse.json({ code, error }, { status });

/** Who is signed in on this browser, if anyone. */
export async function GET(req) {
  try { return NextResponse.json({ address: sessionAddress(req) }); }
  catch (e) { if (e instanceof SessionUnavailable) return refuse(503, 'signin_unavailable', 'Sign-in is not configured on this deployment.'); throw e; }
}

export async function DELETE(req) {
  const res = NextResponse.json({ signedOut: true });
  res.cookies.set(COOKIE, '', cookieOptions(req, 0));
  return res;
}

/**
 * Step two: check the signature over the message the server issued, then set the session cookie.
 *
 * Refused, in order, for: a request from another origin; an unknown nonce; a nonce issued to
 * another origin; one already used; one expired; an owner the registration path would also
 * refuse (a contract, or an EIP-7702 delegate that has not been verified); and a signature by
 * any key but the address's own. The nonce is spent before the signature is checked, so each
 * one gets exactly one try.
 */
export async function POST(req) {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return refuse(403, 'bad_origin', 'Sign-in is only accepted from this site.');
  if (!process.env.SESSION_SECRET) return refuse(503, 'signin_unavailable', 'Sign-in is not configured on this deployment.');
  let body;
  try { body = await req.json(); } catch { return refuse(400, 'bad_request', 'body is not JSON'); }
  const { nonce, signature } = body ?? {};
  if (typeof nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nonce)) return refuse(400, 'bad_request', 'nonce is missing or malformed');
  if (!isHex(signature ?? '') || size(signature) !== 65) return refuse(400, 'bad_request', 'expected a 65-byte signature');

  const row = (await query('SELECT * FROM session_nonces WHERE nonce = $1', [nonce])).rows[0];
  if (!row) return refuse(401, 'unknown_nonce', 'That sign-in request is not one this site issued. Start again.');
  if (row.origin !== origin) return refuse(403, 'bad_origin', 'That sign-in request was issued to a different site.');
  if (row.used_at) return refuse(409, 'nonce_used', 'That sign-in request has already been used. Start again.');
  const now = Math.floor(Date.now() / 1000);
  if (Number(row.expires_at) <= now) return refuse(401, 'nonce_expired', 'That sign-in request has expired. Start again.');

  // The same owner rules as registration: a contract, or an unverified 7702 delegate, is refused.
  const owner = await checkOwner(publicClient(), row.address);
  if (!owner.accepted) return refuse(409, owner.reason ?? 'owner_refused', 'This account cannot sign in: its signatures are checked by a contract this site has not verified.');

  // Spend the nonce now -- one try per nonce, whatever the signature turns out to be.
  const spent = await query('UPDATE session_nonces SET used_at = now() WHERE nonce = $1 AND used_at IS NULL AND expires_at > $2 RETURNING nonce', [nonce, now]);
  if (spent.rowCount !== 1) return refuse(409, 'nonce_used', 'That sign-in request has already been used. Start again.');

  const td = signInTypedData({ chainId: config().chainId, account: row.address, origin: row.origin, nonce,
    issuedAt: row.issued_at, expiresAt: row.expires_at });
  const signer = await recoverTypedDataAddress({ ...td, signature }).catch(() => null);
  if (signer?.toLowerCase() !== row.address) return refuse(401, 'bad_signature', `This was not signed by ${td.message.account}.`);

  const res = NextResponse.json({ address: td.message.account });
  res.cookies.set(COOKIE, issueCookie(row.address), cookieOptions(req));
  return res;
}
