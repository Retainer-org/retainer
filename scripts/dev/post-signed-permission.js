/**
 * Exercise the web API route with a scripted-wallet signature.
 *
 * This validates everything in /api/permissions except the browser SDK itself,
 * so when a real Base Account signs, the only untested surface is the wallet
 * interaction. Uses the SAME allowance/period the page requests, so the two
 * paths produce comparable permissions.
 */
import { createPublicClient, http, encodeAbiParameters, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { spendPermissionManagerAbi, toStruct, config } from '@retainer/chain';

const cfg = config();
const pub = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) });
const owner = privateKeyToAccount(process.env.TEST_USER_PRIVATE_KEY);
const walletAbi = parseAbi(['function replaySafeHash(bytes32 hash) view returns (bytes32)']);

const web = await (await fetch('http://localhost:3017/api/permissions')).json();
const now = Math.floor(Date.now() / 1000);

const permission = {
  account: getAddress(process.env.TEST_SMART_WALLET),
  spender: getAddress(web.router),
  token: getAddress(web.usdc),
  allowance: BigInt(web.allowance),
  period: web.periodInDays * 86400,
  start: now,
  end: now + 30 * 24 * 3600,
  salt: BigInt('0x' + Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')),
  extraData: web.extraData,
};
const s = toStruct(permission);
const permissionHash = await pub.readContract({
  address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [s] });
const replaySafe = await pub.readContract({
  address: permission.account, abi: walletAbi, functionName: 'replaySafeHash', args: [permissionHash] });
const inner = await owner.sign({ hash: replaySafe });
const signature = encodeAbiParameters(
  [{ type: 'tuple', components: [{ name: 'ownerIndex', type: 'uint256' }, { name: 'signatureData', type: 'bytes' }] }],
  [{ ownerIndex: 0n, signatureData: inner }]);

const res = await fetch('http://localhost:3017/api/permissions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ permissionHash, signature, chainId: cfg.chainId, permission },
    (k, v) => (typeof v === 'bigint' ? v.toString() : v)),
});
console.log('HTTP', res.status);
console.log(JSON.stringify(await res.json(), null, 2));
