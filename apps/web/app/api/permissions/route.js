import { NextResponse } from 'next/server';
import { createWalletClient, createPublicClient, http, getAddress, hexToBigInt, isHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { spendPermissionManagerAbi, encodeExtraData, toStruct, config } from '@retainer/chain';
import { storePermission } from '../../../../cli/src/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the page needs to build the permission. No secrets leave the server. */
export async function GET() {
  const cfg = config();
  return NextResponse.json({
    chainId: cfg.chainId,
    router: cfg.router,
    usdc: cfg.usdc,
    allowance: process.env.WEB_ALLOWANCE ?? '2000000',            // 2 USDC per period
    periodInDays: Number(process.env.WEB_PERIOD_DAYS ?? 1),
    extraData: encodeExtraData(cfg.executor, cfg.treasury),
  });
}

/**
 * Receive the signed permission, register it on-chain with approveWithSignature
 * (permissionless, so we submit and the user pays nothing), and persist it.
 */
export async function POST(req) {
  const cfg = config();
  try {
    const body = await req.json();
    const m = body.permission;

    // The SDK returns salt as a hex string; our storage and the contract take a
    // uint256. Normalise here rather than letting a hex string reach the ABI encoder.
    const salt = isHex(m.salt) ? hexToBigInt(m.salt) : BigInt(m.salt);

    const permission = {
      account: getAddress(m.account),
      spender: getAddress(m.spender),
      token: getAddress(m.token),
      allowance: BigInt(m.allowance),
      period: Number(m.period),
      start: Number(m.start),
      end: Number(m.end),
      salt,
      extraData: m.extraData,
    };

    // Refuse anything not aimed at our router, or not routing to our treasury.
    if (permission.spender.toLowerCase() !== cfg.router.toLowerCase()) {
      return NextResponse.json({ error: 'spender is not the Retainer router' }, { status: 400 });
    }
    if (permission.extraData.toLowerCase() !== encodeExtraData(cfg.executor, cfg.treasury).toLowerCase()) {
      return NextResponse.json({ error: 'extraData does not encode (executor, treasury)' }, { status: 400 });
    }

    const pub = createPublicClient({ chain: baseSepolia, transport: http(cfg.rpcUrl) });
    const s = toStruct(permission);

    // Recompute the hash server-side rather than trusting the client's.
    const permissionHash = await pub.readContract({
      address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [s],
    });
    if (body.permissionHash && body.permissionHash.toLowerCase() !== permissionHash.toLowerCase()) {
      return NextResponse.json(
        { error: 'permission hash mismatch', client: body.permissionHash, server: permissionHash },
        { status: 400 });
    }

    let approvedTxHash = null;
    const already = await pub.readContract({
      address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'isApproved', args: [s] });

    if (!already) {
      const wallet = createWalletClient({
        account: privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY),
        chain: baseSepolia, transport: http(cfg.rpcUrl),
      });
      approvedTxHash = await wallet.writeContract({
        address: cfg.manager, abi: spendPermissionManagerAbi,
        functionName: 'approveWithSignature', args: [s, body.signature],
      });
      const r = await pub.waitForTransactionReceipt({ hash: approvedTxHash });
      if (r.status !== 'success') {
        return NextResponse.json({ error: 'approveWithSignature reverted', tx: approvedTxHash }, { status: 502 });
      }
    }

    const id = await storePermission({ ...permission, permissionHash, signature: body.signature, approvedTxHash });

    return NextResponse.json({
      permissionId: String(id),
      permissionHash,
      account: permission.account,
      spender: permission.spender,
      allowance: permission.allowance.toString(),
      periodSeconds: permission.period,
      registeredOnChain: Boolean(approvedTxHash) || already,
      approveTx: approvedTxHash,
      explorer: approvedTxHash ? `https://sepolia.basescan.org/tx/${approvedTxHash}` : null,
      gasPaidBy: 'retainer executor (signer paid nothing)',
    });
  } catch (e) {
    return NextResponse.json({ error: String(e?.shortMessage ?? e?.message ?? e) }, { status: 500 });
  }
}
