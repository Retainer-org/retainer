/**
 * Create, sign and register a spend permission for the scripted test wallet.
 *
 * Signing for a CoinbaseSmartWallet is not a plain EIP-712 signature: the hash
 * must be wrapped by the account's replaySafeHash, and the signature must be
 * wrapped in a SignatureWrapper(ownerIndex, signature). This mirrors exactly
 * what upstream's own Foundry test base does.
 *
 * Registration uses approveWithSignature, which is permissionless -- so OUR
 * executor submits it and the user pays no gas.
 */
import { createPublicClient, createWalletClient, http, encodeAbiParameters, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { spendPermissionManagerAbi, encodeExtraData, toStruct } from '@retainer/chain';
import { storePermission } from '../apps/cli/src/store.js';

const rpc = process.env.BASE_SEPOLIA_RPC_URL;
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const owner = privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY);
const exec = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY);
const execW = createWalletClient({ account: exec, chain: baseSepolia, transport: http(rpc) });

const MANAGER = getAddress(process.env.SPEND_PERMISSION_MANAGER);
const ROUTER = getAddress(process.env.SPEND_ROUTER);
const USDC = getAddress(process.env.USDC_ADDRESS);
const TREASURY = getAddress(process.env.MERCHANT_TREASURY_ADDRESS);
const walletAbi = parseAbi(['function replaySafeHash(bytes32 hash) view returns (bytes32)']);

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const log = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

export async function createPermission({
  account, allowance, periodSeconds, startTs, endTs, salt, register = true,
}) {
  const permission = {
    account: getAddress(account),
    spender: ROUTER,                                   // the router IS the spender
    token: USDC,
    allowance: BigInt(allowance),
    period: Number(periodSeconds),
    start: Number(startTs),
    end: Number(endTs),
    salt: BigInt(salt ?? Math.floor(Math.random() * 1e15)),
    extraData: encodeExtraData(exec.address, TREASURY), // (executor, recipient)
  };
  const s = toStruct(permission);

  const permissionHash = await pub.readContract({
    address: MANAGER, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [s] });

  // CoinbaseSmartWallet signature: replaySafeHash + SignatureWrapper.
  const replaySafe = await pub.readContract({
    address: permission.account, abi: walletAbi, functionName: 'replaySafeHash', args: [permissionHash] });
  const inner = await owner.sign({ hash: replaySafe });
  const signature = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }],
    [{ ownerIndex: 0n, signatureData: inner }],
  );

  let approvedTxHash = null;
  if (register) {
    const already = await pub.readContract({
      address: MANAGER, abi: spendPermissionManagerAbi, functionName: 'isApproved', args: [s] });
    if (!already) {
      approvedTxHash = await execW.writeContract({
        address: MANAGER, abi: spendPermissionManagerAbi,
        functionName: 'approveWithSignature', args: [s, signature] });
      const r = await pub.waitForTransactionReceipt({ hash: approvedTxHash });
      if (r.status !== 'success') throw new Error(`approveWithSignature reverted: ${approvedTxHash}`);
    }
  }

  const id = await storePermission({ ...permission, permissionHash, signature, approvedTxHash });
  return { id, permissionHash, permission, signature, approvedTxHash };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = Math.floor(Date.now() / 1000);
  const out = await createPermission({
    account: arg('account', process.env.TEST_SMART_WALLET),
    allowance: arg('allowance', '5000000'),          // 5 USDC per period, under the 20 balance
    periodSeconds: arg('period', '3600'),
    startTs: arg('start', String(now)),
    endTs: arg('end', String(now + 30 * 24 * 3600)),
    salt: arg('salt'),
    register: arg('register', 'true') !== 'false',
  });
  log({ created: true, id: out.id, permissionHash: out.permissionHash,
        approvedTx: out.approvedTxHash, allowance: out.permission.allowance,
        period: out.permission.period, start: out.permission.start, end: out.permission.end });
  const { close } = await import('@retainer/db');
  await close();
}
