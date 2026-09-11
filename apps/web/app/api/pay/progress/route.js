import { NextResponse } from 'next/server';
import { query } from '@retainer/db';
import { verifyReceipt } from '../../../../lib/links.js';
import { SessionUnavailable } from '../../../../lib/session.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The first charge of ONE permission: the one named inside a receipt that registration
 * handed to the page which created it. The receipt is the only input read -- no address,
 * no permission id, no other parameter -- so this can never become a lookup of anyone's
 * records. It exists so a customer who has just signed sees their first charge progress
 * without being asked to sign again; coming back later is what /account is for.
 */
export async function GET(req) {
  let pid;
  try { pid = verifyReceipt(new URL(req.url).searchParams.get('receipt')); }
  catch (e) { if (e instanceof SessionUnavailable) return NextResponse.json({ code: 'unavailable', error: 'Not configured on this deployment.' }, { status: 503 }); throw e; }
  if (!pid) return NextResponse.json({ code: 'bad_receipt', error: 'That receipt is not valid, or has expired. Your permissions page shows everything.' }, { status: 401 });

  const p = (await query(
    `SELECT p.id, p.approved_tx_hash, l.first_charge::text AS first_charge, l.first_charge_amount, l.merchant_name
       FROM permissions p LEFT JOIN billing_links l ON l.id = p.link_id WHERE p.id = $1`, [pid])).rows[0];
  if (!p) return NextResponse.json({ code: 'bad_receipt', error: 'Unknown permission.' }, { status: 401 });
  const ch = (await query(
    `SELECT c.id, c.state::text AS state, c.amount, c.confirmed_tx_hash, c.confirmed_amount, c.last_failure::text AS failure,
            c.next_attempt_at,
            (SELECT a.tx_hash FROM charge_attempts a WHERE a.charge_id = c.id ORDER BY a.id DESC LIMIT 1) AS sent_tx
       FROM charges c WHERE c.permission_id = $1 ORDER BY c.id ASC LIMIT 1`, [pid])).rows[0] ?? null;

  return NextResponse.json({
    permissionId: String(p.id), merchantName: p.merchant_name, registrationTx: p.approved_tx_hash,
    firstCharge: p.first_charge ? { rule: p.first_charge, amount: p.first_charge_amount == null ? null : String(p.first_charge_amount) } : null,
    charge: ch && {
      id: String(ch.id), state: ch.state, amount: String(ch.amount), failure: ch.failure,
      dueAt: new Date(ch.next_attempt_at).toISOString(), sentTx: ch.sent_tx, confirmedTx: ch.confirmed_tx_hash,
      settledAmount: ch.confirmed_amount == null ? null : String(ch.confirmed_amount),
    },
  });
}
