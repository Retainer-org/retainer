import { createHash } from 'node:crypto';
import { getAddress } from 'viem';
import { config, encodeExtraData, SMART_WALLET_FACTORY } from '@retainer/chain';

/**
 * What a registration is allowed to contain, pinned to configuration.
 *
 * Registration costs the executor gas, and before this existed a caller could
 * make it pay to register any allowance, period or expiry they liked -- only
 * the spender and the routing were checked. Every field a customer's terms are
 * made of is now fixed here, and anything else is refused before a transaction
 * is built or a row is written.
 */
export function policy() {
  const cfg = config();
  const DAY = 86400;
  return {
    chainId: cfg.chainId,
    manager: getAddress(cfg.manager),
    router: getAddress(cfg.router),
    usdc: getAddress(cfg.usdc),
    executor: getAddress(cfg.executor),
    treasury: getAddress(cfg.treasury),
    factory: SMART_WALLET_FACTORY,
    extraData: encodeExtraData(cfg.executor, cfg.treasury),
    allowance: BigInt(process.env.WEB_ALLOWANCE ?? '2000000'),                 // 2 USDC per period
    periodSeconds: Number(process.env.WEB_PERIOD_DAYS ?? 1) * DAY,
    durationSeconds: Number(process.env.WEB_DURATION_DAYS ?? 30) * DAY,     // start -> end, exactly
    startToleranceSeconds: 600,                                              // clock skew between page and server
    limits: {
      perSignerSeconds: Number(process.env.REGISTRATION_SIGNER_COOLDOWN_SECONDS ?? 600),
      perIpPerHour: Number(process.env.REGISTRATION_PER_IP_PER_HOUR ?? 5),
      globalPerHour: Number(process.env.REGISTRATION_GLOBAL_PER_HOUR ?? 60),
    },
  };
}

/** The same policy, safe to send to a browser. */
export function publicPolicy(pol = policy()) {
  return {
    ...pol,
    allowance: pol.allowance.toString(),
    periodInDays: pol.periodSeconds / 86400,
    // Registration needs the executor key. Saying so up front means no one signs into a refusal.
    registrationEnabled: Boolean(process.env.EXECUTOR_PRIVATE_KEY),
  };
}

/**
 * Returns null if `p` (a normalised struct) is exactly what policy allows,
 * otherwise the first field that is not, with what was expected. Exact
 * equality throughout: "at most" would still let a caller choose.
 */
export function checkPolicy(p, pol, now) {
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const fail = (field, expected, got) => ({ field, expected: String(expected), got: String(got) });
  if (!eq(p.token, pol.usdc)) return fail('token', pol.usdc, p.token);
  if (!eq(p.spender, pol.router)) return fail('spender', pol.router, p.spender);
  if (!eq(p.extraData, pol.extraData)) return fail('extraData', pol.extraData, p.extraData);
  if (p.allowance !== pol.allowance) return fail('allowance', pol.allowance, p.allowance);
  if (p.period !== pol.periodSeconds) return fail('period', pol.periodSeconds, p.period);
  if (p.end - p.start !== pol.durationSeconds) return fail('end', `start + ${pol.durationSeconds}`, `start + ${p.end - p.start}`);
  if (Math.abs(p.start - now) > pol.startToleranceSeconds) return fail('start', `within ${pol.startToleranceSeconds}s of now (${now})`, p.start);
  return null;
}

/** Client identity for rate limiting only: a hash, never the address itself. */
export function ipHashFrom(req) {
  const ip = req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  return createHash('sha256').update(`retainer-registration:${ip}`).digest('hex');
}
