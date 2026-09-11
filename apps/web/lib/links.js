import { timingSafeEqual } from 'node:crypto';
import { query } from '@retainer/db';
import { macFor } from './session.js';

/**
 * Billing links: loading one, deciding what state it is in, and the public view of it.
 *
 * The token is the only thing a caller supplies. Everything the customer agrees to comes
 * from the row, and registration re-derives the terms from the row too (linkPolicy) -- so
 * no caller, page or script can alter what a link offers.
 */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

export async function loadLink(token) {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  return (await query('SELECT * FROM billing_links WHERE token = $1', [token])).rows[0] ?? null;
}

/** 'not_found' | 'revoked' | 'used' | 'expired' | 'valid' -- checked in that order. */
export function linkState(row, nowMs = Date.now()) {
  if (!row) return 'not_found';
  if (row.revoked_at) return 'revoked';
  if (row.single_use && row.used_at) return 'used';
  if (new Date(row.expires_at).getTime() <= nowMs) return 'expired';
  return 'valid';
}

/** What a browser may see about a link. Nothing here is secret; the token itself is the capability. */
export function linkView(row) {
  return {
    token: row.token, state: linkState(row), merchantName: row.merchant_name, treasury: row.treasury,
    allowance: String(row.allowance), periodSeconds: Number(row.period_seconds), durationSeconds: Number(row.duration_seconds),
    startAt: row.start_at == null ? null : Number(row.start_at),
    firstCharge: row.first_charge, firstChargeAmount: row.first_charge_amount == null ? null : String(row.first_charge_amount),
    expiresAt: new Date(row.expires_at).toISOString(), singleUse: row.single_use,
  };
}

/**
 * A receipt for one permission, returned by registration so the page that created it can
 * watch its first charge -- and nothing else. It names a single permission id, MACed with
 * the server secret under its own purpose ("receipt:"), so a session cookie can never pass
 * as one and one receipt can never name another permission. Short-lived; the page keeps it
 * in memory only.
 */
export const RECEIPT_SECONDS = 3600;

export function issueReceipt(permissionId, nowMs = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ v: 1, p: String(permissionId), exp: Math.floor(nowMs / 1000) + RECEIPT_SECONDS })).toString('base64url');
  return `${payload}.${macFor('receipt', payload).toString('base64url')}`;
}

/** The permission id a receipt names, or null if it is malformed, tampered with or expired. */
export function verifyReceipt(receipt) {
  if (typeof receipt !== 'string') return null;
  const [payload, sig] = receipt.split('.');
  if (!payload || !sig) return null;
  const want = macFor('receipt', payload), got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (o?.v !== 1 || !/^\d+$/.test(o.p ?? '') || !(o.exp > Date.now() / 1000)) return null;
  return o.p;
}
