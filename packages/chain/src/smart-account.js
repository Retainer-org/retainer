import { encodeAbiParameters, encodeFunctionData, concat, getAddress, parseAbi, hashTypedData, keccak256 } from 'viem';
import { SPEND_PERMISSION_EIP712_TYPES } from './permission.js';

/**
 * EOA-owned smart accounts: the path for MetaMask and other injected wallets.
 *
 * A spend permission's `account` must be a CoinbaseSmartWallet, because the
 * manager moves funds by calling execute() on it. An EOA cannot be that account,
 * but it can OWN one. Everything here derives that account from the EOA,
 * describes what the EOA signs, and wraps the signature so the account can be
 * created and approved in a single approveWithSignature -- one signature from
 * the customer, no separate deployment step, and gas paid by the executor.
 *
 * Shared by the server (which builds the final signature itself), the sign page
 * (which shows the customer exactly what they are signing) and the drills.
 */

/** Canonical CoinbaseSmartWalletFactory; the same address our Phase 1 wallet came from. */
export const SMART_WALLET_FACTORY = '0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a';

/** Nonce 0: one EOA always derives the same account, so it can be shown and funded before it exists. */
export const SMART_ACCOUNT_NONCE = 0n;

/** ERC-6492 detection suffix. */
export const ERC6492_MAGIC = '0x6492649264926492649264926492649264926492649264926492649264926492';

export const smartWalletFactoryAbi = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);

export const smartWalletAbi = parseAbi([
  'function execute(address target, uint256 value, bytes data) payable',
  'function isOwnerAddress(address account) view returns (bool)',
  'function replaySafeHash(bytes32 hash) view returns (bytes32)',
]);

const encOwner = (a) => encodeAbiParameters([{ type: 'address' }], [getAddress(a)]);

/**
 * Initial owners: the customer's EOA at index 0, the SpendPermissionManager at 1.
 *
 * The manager must be an owner or every charge reverts (execute() is
 * onlyEntryPointOrOwner). Naming it at creation removes the addOwnerAddress
 * transaction our Phase 1 setup script needed. Order is load-bearing: the
 * signature wrapper names ownerIndex 0, so the EOA must be first.
 */
export function ownersFor(eoa, manager) {
  return [encOwner(eoa), encOwner(manager)];
}

export function deployCalldata(eoa, manager) {
  return encodeFunctionData({
    abi: smartWalletFactoryAbi, functionName: 'createAccount',
    args: [ownersFor(eoa, manager), SMART_ACCOUNT_NONCE],
  });
}

/** The counterfactual address. Deterministic from (owners, nonce); valid before deployment. */
export async function deriveSmartAccount(client, eoa, manager) {
  return client.readContract({
    address: SMART_WALLET_FACTORY, abi: smartWalletFactoryAbi, functionName: 'getAddress',
    args: [ownersFor(eoa, manager), SMART_ACCOUNT_NONCE],
  });
}

/**
 * What the customer's wallet actually signs: CoinbaseSmartWalletMessage{hash}
 * under the smart account's own EIP-712 domain. Its digest is exactly the
 * account's replaySafeHash(hash), which is what ERC-1271 validation checks --
 * so eth_signTypedData_v4 produces a valid signature, and no raw-hash signing
 * (which MetaMask does not offer) is needed.
 */
export function smartWalletTypedData(account, chainId, permissionHash) {
  return {
    domain: { name: 'Coinbase Smart Wallet', version: '1', chainId, verifyingContract: getAddress(account) },
    types: { CoinbaseSmartWalletMessage: [{ name: 'hash', type: 'bytes32' }] },
    primaryType: 'CoinbaseSmartWalletMessage',
    message: { hash: permissionHash },
  };
}

/** CoinbaseSmartWallet.SignatureWrapper(ownerIndex, signatureData). */
export function wrapOwnerSignature(signature, ownerIndex = 0n) {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }],
    [{ ownerIndex, signatureData: signature }],
  );
}

/** ERC-6492: abi.encode(factory, factoryCalldata, innerSignature) ++ magic. */
export function erc6492Wrap(factoryCalldata, innerSignature) {
  return concat([
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }],
      [SMART_WALLET_FACTORY, factoryCalldata, innerSignature]),
    ERC6492_MAGIC,
  ]);
}

/**
 * The signature approveWithSignature receives. Always 6492-wrapped: on an
 * undeployed account the validator deploys it first; on a deployed one Solady
 * tries the inner signature before any side effect. One path for new and
 * returning customers.
 */
export function registrationSignature(eoa, manager, typedDataSignature) {
  return erc6492Wrap(deployCalldata(eoa, manager), wrapOwnerSignature(typedDataSignature, 0n));
}

/**
 * Classify an owner by the code at its address, read from the chain.
 *
 * Solady's signature checker uses plain ecrecover only when the signer has NO
 * code. An EIP-7702-upgraded account has code (0xef0100 ++ delegate), so its
 * signatures are judged by its delegate contract instead. Any other code is a
 * contract wallet. This only classifies; whether an owner is ACCEPTED is decided
 * by checkOwner below, which admits a plain EOA or a pinned, verified delegate.
 * The chain's answer is used, never a wallet's self-report.
 */
export function classifyOwnerCode(code) {
  if (!code || code === '0x') return { kind: 'eoa' };
  const c = code.toLowerCase();
  if (c.startsWith('0xef0100') && c.length === 2 + 46) return { kind: 'eip7702', delegate: getAddress(`0x${c.slice(8)}`) };
  return { kind: 'contract' };
}

/**
 * EIP-7702 delegates accepted as the owner of a customer's smart account. ONE address, by decision.
 *
 * By default an owner with code is refused: CoinbaseSmartWallet hands the signature check to the
 * owner's own contract, and an arbitrary contract's idea of a valid signature cannot be vouched for.
 * This is a deliberate, scoped exception, not a relaxation of that rule:
 *
 *   0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B -- MetaMask EIP7702StatelessDeleGator
 *   (verified source on Basescan, Base Sepolia). Its _isValidSignature is
 *       if (ECDSA.recover(_hash, _signature) == address(this)) return EIP1271_MAGIC_VALUE;
 *   i.e. a plain ECDSA signature by the account's own key, with no wrapping of its own -- the same
 *   security property as a plain EOA, which is what the rest of this flow already relies on.
 *
 *   Why it is needed: in a live session MetaMask converted customer accounts to this delegate by
 *   itself, inside the revoke transaction. Without the exception, a customer who cancelled could
 *   never register again.
 *
 *   Tested 2026-09-10 at block 46652541 (delegation tx 0x930de800f78638f8f2457e5b5b0d182f44fb73807da704d56f83f39a97fdebe2):
 *   the delegator accepts the owner's typed-data signature, approveWithSignature with ERC-6492
 *   creation succeeds, and the same message signed by any other key is refused on both paths.
 *
 * codeHash pins the exact runtime code that was read and tested. If the code at the address ever
 * hashes differently, the exception no longer applies and the owner is refused: a trusted address
 * whose code can silently change is exactly the kind of assumption that rots. Adding an entry here
 * needs the same review -- source read, behaviour tested with negative controls, hash pinned.
 */
export const TRUSTED_7702_DELEGATES = Object.freeze({
  '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b': Object.freeze({
    name: 'MetaMask EIP7702StatelessDeleGator',
    codeHash: '0x83805f9ac7395294043b10c3b7c1839b7e4582a3e693028c36df84978b09d4e2',
    testedAtBlock: 46652541,
  }),
});

/**
 * Whether an address may own a customer's smart account, decided from the chain.
 *
 *   accepted: true   a plain EOA; or a 7702 account delegating to a TRUSTED_7702_DELEGATES entry
 *                    whose deployed code still hashes to the reviewed version
 *   accepted: false  reason 'contract_owner' | 'eip7702' (any other delegate) | 'delegate_code_changed'
 *
 * `trusted` is a parameter only so the drills can prove the code-hash check refuses; production
 * callers never pass it.
 */
export async function checkOwner(client, owner, { trusted = TRUSTED_7702_DELEGATES, blockNumber } = {}) {
  const k = classifyOwnerCode(await client.getCode({ address: owner, blockNumber }));
  if (k.kind === 'eoa') return { ...k, accepted: true };
  if (k.kind === 'contract') return { ...k, accepted: false, reason: 'contract_owner' };
  const t = trusted[k.delegate.toLowerCase()];
  if (!t) return { ...k, accepted: false, reason: 'eip7702' };
  const code = await client.getCode({ address: k.delegate, blockNumber });
  const got = code && code !== '0x' ? keccak256(code) : null;
  if (!got || got.toLowerCase() !== t.codeHash.toLowerCase()) {
    return { ...k, accepted: false, reason: 'delegate_code_changed', expected: t.codeHash, got };
  }
  return { ...k, accepted: true, trustedDelegate: t.name };
}

/** The manager's EIP-712 domain, read from the chain rather than assumed. */
export async function managerDomain(client, manager) {
  const [, name, version, chainId, verifyingContract] = await client.readContract({
    address: manager,
    abi: parseAbi(['function eip712Domain() view returns (bytes1, string, string, uint256, address, bytes32, uint256[])']),
    functionName: 'eip712Domain',
  });
  return { name, version, chainId: Number(chainId), verifyingContract };
}

/** The permission hash computed locally; must equal manager.getHash() for the same struct. */
export function localPermissionHash(domain, struct) {
  return hashTypedData({ domain, types: SPEND_PERMISSION_EIP712_TYPES, primaryType: 'SpendPermission', message: struct });
}
