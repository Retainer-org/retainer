import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The customer session: an HTTP-only cookie carrying one address and an expiry, MACed with
 * SESSION_SECRET. It is only ever issued after a sign-in signature has been verified, and it
 * is the ONLY source of "who is asking" for customer data -- no route takes an address from
 * a parameter. Stateless: nothing to look up per request, nothing to leak from a table.
 */
export const COOKIE = 'retainer_session';
export const SESSION_SECONDS = 12 * 3600;
export const NONCE_SECONDS = 300;
export const NONCES_PER_IP_PER_HOUR = 30;

export class SessionUnavailable extends Error {}

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new SessionUnavailable('SESSION_SECRET is not configured');
  return s;
}
const mac = (payload) => createHmac('sha256', secret()).update(payload).digest();
/** A MAC for another purpose (e.g. "receipt"). The prefix keeps it from ever matching a session cookie's MAC. */
export const macFor = (purpose, payload) => createHmac('sha256', secret()).update(`${purpose}:${payload}`).digest();

export function issueCookie(address, nowMs = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ v: 1, a: address.toLowerCase(), exp: Math.floor(nowMs / 1000) + SESSION_SECONDS })).toString('base64url');
  return `${payload}.${mac(payload).toString('base64url')}`;
}

/** The signed-in address (lowercase), or null. Throws SessionUnavailable if the server cannot check. */
export function sessionAddress(req) {
  const raw = req.cookies.get(COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const want = mac(payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (o?.v !== 1 || !/^0x[0-9a-f]{40}$/.test(o.a ?? '') || !(o.exp > Date.now() / 1000)) return null;
  return o.a;
}

/** Origins allowed to sign in. The browser sets Origin; a page elsewhere cannot forge it. */
export function allowedOrigins() {
  return (process.env.SESSION_ORIGINS ?? 'https://retainer-one.vercel.app,http://localhost:3017')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

export function cookieOptions(req, maxAge = SESSION_SECONDS) {
  const https = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  return { httpOnly: true, secure: https, sameSite: 'strict', path: '/', maxAge };
}

export const newNonce = () => randomBytes(16).toString('hex');
