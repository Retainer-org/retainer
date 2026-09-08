/** Revoke a permission as the spender (the router), to drive the REVOKED drill. */
import { createPublicClient, createWalletClient, http, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { spendRouterAbi, toStruct } from '@retainer/chain';
import { query, close } from '@retainer/db';
import { markRevoked } from '../apps/cli/src/store.js';

const rpc = process.env.BASE_SEPOLIA_RPC_URL;
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const exec = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY);
const wallet = createWalletClient({ account: exec, chain: baseSepolia, transport: http(rpc) });

const i = process.argv.indexOf('--permission');
const key = process.argv[i + 1];
const { rows } = await query('SELECT * FROM permissions WHERE id::text = $1 OR permission_hash = $1', [key]);
if (!rows.length) throw new Error('permission not found');
const p = rows[0];

const s = toStruct({
  account: p.account, spender: p.spender, token: p.token, allowance: p.allowance,
  period: p.period_seconds, start: p.start_ts, end: p.end_ts, salt: p.salt, extraData: p.extra_data,
});
const hash = await wallet.writeContract({
  address: getAddress(process.env.SPEND_ROUTER), abi: spendRouterAbi,
  functionName: 'revokeAsSpender', args: [s],
});
const r = await pub.waitForTransactionReceipt({ hash });
if (r.status !== 'success') throw new Error(`revoke reverted: ${hash}`);
await markRevoked(p.permission_hash, hash);
console.log(JSON.stringify({ revoked: true, permissionHash: p.permission_hash, tx: hash }, null, 2));
await close();
