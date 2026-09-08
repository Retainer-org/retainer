// Revert decoding for the failure classifier.
//
// These selectors are pinned by contracts/test/retainer/ErrorSelectors.t.sol.
// If that test fails, an upstream contract change moved a signature and BOTH
// files must be updated -- never just one, or classification silently degrades
// to UNKNOWN.

export const SELECTORS = {
  // SpendPermissionManager
  '0x282b9f97': 'UnauthorizedSpendPermission',
  '0xfd1ebc88': 'ExceededSpendPermission',
  '0x00a170cd': 'BeforeSpendPermissionStart',
  '0x4f0a481c': 'AfterSpendPermissionEnd',
  '0x7c946ed7': 'ZeroValue',
  '0xe1130dba': 'InvalidSender',
  '0xb27ed7ef': 'SpendValueOverflow',
  '0x8baa579f': 'InvalidSignature',
  // SpendRouter
  '0x85faaab5': 'UnauthorizedSender',
  '0x784dc36e': 'MalformedExtraData',
  '0xd92e233d': 'ZeroAddress',
  '0x5c60991a': 'PermissionApprovalFailed',
  // solidity built-ins
  '0x08c379a0': 'Error(string)',
  '0x4e487b71': 'Panic(uint256)',
};

export const FAILURE_MODES = /** @type {const} */ ([
  'REVOKED', 'EXPIRED', 'INSUFFICIENT_BALANCE',
  'ALLOWANCE_EXHAUSTED', 'NOT_STARTED', 'NOT_APPROVED', 'UNKNOWN',
]);

/** Pull the 4-byte selector out of whatever shape viem hands us. */
export function extractSelector(err) {
  const candidates = [
    err?.cause?.data, err?.data, err?.cause?.cause?.data,
    err?.cause?.raw, err?.raw,
    err?.details, err?.shortMessage, err?.message,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') {
      const m = c.match(/0x[0-9a-fA-F]{8,}/);
      if (m) return m[0].slice(0, 10).toLowerCase();
    }
  }
  return null;
}

/**
 * Map a decoded revert to a failure mode.
 *
 * This is the RACE FALLBACK only. Normal classification comes from reading
 * chain state before broadcasting (see classify.js) -- decoding a revert means
 * state changed between simulation and inclusion, which is rare but real.
 *
 * UnauthorizedSpendPermission cannot distinguish revoked from never-approved,
 * so it is resolved against isRevoked() by the caller rather than guessed here.
 */
export function modeFromSelector(selector, revertText = '') {
  const name = SELECTORS[selector];
  switch (name) {
    case 'ExceededSpendPermission':     return 'ALLOWANCE_EXHAUSTED';
    case 'BeforeSpendPermissionStart':  return 'NOT_STARTED';
    case 'AfterSpendPermissionEnd':     return 'EXPIRED';
    case 'UnauthorizedSpendPermission': return null; // caller disambiguates
    case 'Error(string)': {
      // Circle's USDC reverts with a plain string, not a custom error, so this
      // is the one mode that has no selector of its own.
      const t = revertText.toLowerCase();
      if (t.includes('exceeds balance') || t.includes('insufficient')) return 'INSUFFICIENT_BALANCE';
      return 'UNKNOWN';
    }
    default: return 'UNKNOWN';
  }
}

export function selectorName(selector) {
  return SELECTORS[selector] ?? null;
}
