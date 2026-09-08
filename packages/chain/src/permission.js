import { encodeAbiParameters, decodeAbiParameters, getAddress } from 'viem';

/**
 * extraData is exactly abi.encode(executor, recipient) -- 64 bytes.
 * SpendRouter reverts with MalformedExtraData on anything else.
 */
export function encodeExtraData(executor, recipient) {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [getAddress(executor), getAddress(recipient)],
  );
}

export function decodeExtraData(extraData) {
  const [executor, recipient] = decodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }], extraData,
  );
  return { executor, recipient };
}

/**
 * Period boundaries are fixed intervals from `start`, per the contract:
 *   [start + n*period, min(end, start + (n+1)*period) - 1]
 *
 * Derived, never chosen. This is what makes (permission_id, period_start) a
 * safe idempotency key with no coordination between workers.
 */
export function periodFor(permission, atUnixSeconds) {
  const start = BigInt(permission.start);
  const end = BigInt(permission.end);
  const period = BigInt(permission.period);
  const t = BigInt(atUnixSeconds);

  if (t < start) return { index: null, periodStart: null, periodEnd: null, state: 'NOT_STARTED' };
  if (t >= end)  return { index: null, periodStart: null, periodEnd: null, state: 'EXPIRED' };

  const index = (t - start) / period;
  const periodStart = start + index * period;
  const rawEnd = start + (index + 1n) * period;
  const periodEnd = rawEnd < end ? rawEnd : end;
  return { index, periodStart, periodEnd, state: 'ACTIVE' };
}

/** Struct in the exact field order the contract and EIP-712 type expect. */
export function toStruct(p) {
  return {
    account: getAddress(p.account),
    spender: getAddress(p.spender),
    token: getAddress(p.token),
    allowance: BigInt(p.allowance),
    period: Number(p.period),
    start: Number(p.start),
    end: Number(p.end),
    salt: BigInt(p.salt),
    extraData: p.extraData,
  };
}

export const SPEND_PERMISSION_EIP712_TYPES = {
  SpendPermission: [
    { name: 'account', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'allowance', type: 'uint160' },
    { name: 'period', type: 'uint48' },
    { name: 'start', type: 'uint48' },
    { name: 'end', type: 'uint48' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraData', type: 'bytes' },
  ],
};
