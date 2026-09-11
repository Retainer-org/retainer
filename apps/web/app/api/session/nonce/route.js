import { NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { config } from '@retainer/chain';
import { query } from '@retainer/db';
import { allowedOrigins, newNonce, NONCE_SECONDS, NONCES_PER_IP_PER_HOUR } from '../../../../lib/session.js';
import { ipHashFrom } from '../../permissions/policy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const refuse = (status, code, error) => NextResponse.json({ code, error }, { status });

/**
 * Step one of signing in: a single-use nonce, bound to the address and the origin asking.
 * Returns the exact fields the wallet will sign; the server keeps its own copy and rebuilds
 * the message from it when checking the signature.
 */
export async function POST(req) {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return refuse(403, 'bad_origin', 'Sign-in is only accepted from this site.');
  if (!process.env.SESSION_SECRET) return refuse(503, 'signin_unavailable', 'Sign-in is not configured on this deployment.');
  let body;
  try { body = await req.json(); } catch { return refuse(400, 'bad_request', 'body is not JSON'); }
  if (!isAddress(body?.address ?? '')) return refuse(400, 'bad_request', 'address is missing or not an address');

  const ipHash = ipHashFrom(req);
  const now = Math.floor(Date.now() / 1000);
  const recent = (await query('SELECT count(*)::int AS c FROM session_nonces WHERE ip_hash = $1 AND issued_at > $2', [ipHash, now - 3600])).rows[0].c;
  if (recent >= NONCES_PER_IP_PER_HOUR) return refuse(429, 'rate_limited', 'Too many sign-in attempts from this network. Try again later.');

  const nonce = newNonce();
  const account = getAddress(body.address);
  await query(`INSERT INTO session_nonces (nonce, address, origin, issued_at, expires_at, ip_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
    [nonce, account.toLowerCase(), origin, now, now + NONCE_SECONDS, ipHash]);
  await query('DELETE FROM session_nonces WHERE expires_at < $1', [now - 86400]);
  return NextResponse.json({ chainId: config().chainId, account, origin, nonce, issuedAt: now, expiresAt: now + NONCE_SECONDS });
}
