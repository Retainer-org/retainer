import { NextResponse } from 'next/server';
import { config, publicClient, readGasTank } from '@retainer/chain';
import { linkPolicy, publicPolicy } from '../../permissions/policy.js';
import { loadLink, linkState, linkView } from '../../../../lib/links.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A billing link as the pay page needs it: its state, and -- for a valid link -- the exact
 * terms, in the same shape as the policy the sign page reads. The page builds the permission
 * from these; registration ignores them and re-derives the terms from the row.
 */
export async function GET(_req, { params }) {
  const { token } = await params;
  const row = await loadLink(token);
  const state = linkState(row);
  if (state === 'not_found') return NextResponse.json({ state }, { status: 404 });
  const link = linkView(row);
  if (state !== 'valid') return NextResponse.json({ state, link: { merchantName: link.merchantName, expiresAt: link.expiresAt } });

  const pol = publicPolicy(linkPolicy(row));
  const tank = pol.registrationEnabled ? await readGasTank(publicClient(), config().executor).catch(() => null) : null;
  const gasLow = Boolean(tank && !tank.registrationOpen);
  return NextResponse.json({ state, link, policy: { ...pol, registrationEnabled: pol.registrationEnabled && !gasLow,
    registrationClosedReason: !pol.registrationEnabled ? 'no_executor_key' : gasLow ? 'gas_tank_low' : null } });
}
