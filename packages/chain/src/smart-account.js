import { encodeAbiParameters, encodeFunctionData, concat, getAddress, parseAbi, hashTypedData } from 'viem';
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
 * signatures are judged by its delegate contract instead, with an outcome we
 * have not verified. Any other code is a contract wallet. Only 'eoa' proceeds.
 * The chain's answer is used, never a wallet's self-report.
 */
export function classifyOwnerCode(code) {
  if (!code || code === '0x') return { kind: 'eoa' };
  const c = code.toLowerCase();
  if (c.startsWith('0xef0100') && c.length === 2 + 46) return { kind: 'eip7702', delegate: getAddress(`0x${c.slice(8)}`) };
  return { kind: 'contract' };
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
