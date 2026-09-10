// Minimal ABIs. Only what the engine actually calls or decodes.

export const spendPermissionManagerAbi = [
  { type: 'function', name: 'getHash', stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'isValid', stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isRevoked', stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [{ type: 'bool' }] },
  // The account's own revocation: requireSender(spendPermission.account), so the customer's
  // smart account calls it via execute(). Used by the sign page's Revoke button.
  { type: 'function', name: 'revoke', stateMutability: 'nonpayable',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [] },
  { type: 'function', name: 'isApproved', stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getCurrentPeriod', stateMutability: 'view',
    inputs: [{ name: 'spendPermission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [{ type: 'tuple', components: [
      { name: 'start', type: 'uint48' }, { name: 'end', type: 'uint48' },
      { name: 'spend', type: 'uint160' }]}] },
  { type: 'function', name: 'approveWithSignature', stateMutability: 'nonpayable',
    inputs: [
      { name: 'spendPermission', type: 'tuple', components: [
        { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
        { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
        { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
        { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
        { name: 'extraData', type: 'bytes' }]},
      { name: 'signature', type: 'bytes' }],
    outputs: [{ type: 'bool' }] },
  { type: 'event', name: 'SpendPermissionUsed', inputs: [
      { name: 'hash', type: 'bytes32', indexed: true },
      { name: 'account', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'token', type: 'address', indexed: false },
      { name: 'periodSpend', type: 'tuple', indexed: false, components: [
        { name: 'start', type: 'uint48' }, { name: 'end', type: 'uint48' },
        { name: 'spend', type: 'uint160' }]}]},
  // custom errors, for decoding reverts
  { type: 'error', name: 'UnauthorizedSpendPermission', inputs: [] },
  { type: 'error', name: 'ExceededSpendPermission', inputs: [{ name: 'value', type: 'uint256' }, { name: 'allowance', type: 'uint256' }] },
  { type: 'error', name: 'BeforeSpendPermissionStart', inputs: [{ name: 'currentTimestamp', type: 'uint48' }, { name: 'start', type: 'uint48' }] },
  { type: 'error', name: 'AfterSpendPermissionEnd', inputs: [{ name: 'currentTimestamp', type: 'uint48' }, { name: 'end', type: 'uint48' }] },
  { type: 'error', name: 'ZeroValue', inputs: [] },
  { type: 'error', name: 'InvalidSender', inputs: [{ name: 'sender', type: 'address' }, { name: 'expected', type: 'address' }] },
  { type: 'error', name: 'SpendValueOverflow', inputs: [{ name: 'value', type: 'uint256' }] },
  { type: 'error', name: 'InvalidSignature', inputs: [] },
];

export const spendRouterAbi = [
  { type: 'function', name: 'spendAndRoute', stateMutability: 'nonpayable',
    inputs: [
      { name: 'permission', type: 'tuple', components: [
        { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
        { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
        { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
        { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
        { name: 'extraData', type: 'bytes' }]},
      { name: 'value', type: 'uint160' }],
    outputs: [] },
  { type: 'function', name: 'revokeAsSpender', stateMutability: 'nonpayable',
    inputs: [{ name: 'permission', type: 'tuple', components: [
      { name: 'account', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'token', type: 'address' }, { name: 'allowance', type: 'uint160' },
      { name: 'period', type: 'uint48' }, { name: 'start', type: 'uint48' },
      { name: 'end', type: 'uint48' }, { name: 'salt', type: 'uint256' },
      { name: 'extraData', type: 'bytes' }]}],
    outputs: [] },
  { type: 'function', name: 'encodeExtraData', stateMutability: 'pure',
    inputs: [{ name: 'executor', type: 'address' }, { name: 'recipient', type: 'address' }],
    outputs: [{ type: 'bytes' }] },
  { type: 'function', name: 'PERMISSION_MANAGER', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'event', name: 'SpendRouted', inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'executor', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'permissionHash', type: 'bytes32', indexed: false },
      { name: 'token', type: 'address', indexed: false },
      { name: 'value', type: 'uint256', indexed: false }]},
  { type: 'error', name: 'UnauthorizedSender', inputs: [{ name: 'caller', type: 'address' }, { name: 'expected', type: 'address' }] },
  { type: 'error', name: 'MalformedExtraData', inputs: [{ name: 'length', type: 'uint256' }, { name: 'extraData', type: 'bytes' }] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'PermissionApprovalFailed', inputs: [] },
];

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
