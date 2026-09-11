import { NextResponse } from 'next/server';
import { createWalletClient, http, getAddress, hexToBigInt, isHex, isAddress, size,
  recoverTypedDataAddress, recoverMessageAddress, recoverAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { spendPermissionManagerAbi, toStruct, config, publicClient,
  deriveSmartAccount, smartWalletTypedData, registrationSignature, checkOwner, readGasTank } from '@retainer/chain';
import { query } from '@retainer/db';
import { storePermission } from '../../../../cli/src/store.js';
import { policy, publicPolicy, checkPolicy, ipHashFrom } from './policy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What the page needs to build a permission the server will accept. No secrets.
 *
 * It used to list any address's permissions given ?signer=0x..., to anyone who asked.
 * That is gone: a customer's own permissions are served only at /api/me/permissions,
 * to a browser that has proven, by signing in, that it controls the address.
 */
export async function GET(req) {
  const signer = new URL(req.url).searchParams.get('signer');
  if (signer !== null) {
    return NextResponse.json({ code: 'moved', error: 'Listing permissions by address was removed. Sign in at /account to see your own.' }, { status: 410 });
  }
  const pol = publicPolicy();
  // Registration also closes when the executor's gas is low, so no one signs into a refusal.
  const tank = pol.registrationEnabled ? await readGasTank(publicClient(), config().executor).catch(() => null) : null;
  const gasLow = Boolean(tank && !tank.registrationOpen);
  return NextResponse.json({ ...pol, registrationEnabled: pol.registrationEnabled && !gasLow,
    registrationClosedReason: !pol.registrationEnabled ? 'no_executor_key' : gasLow ? 'gas_tank_low' : null });
}

/**
 * A refusal: plain words, a machine-readable code, and -- by construction --
 * no transaction sent and no row written. Every early return below is one.
 */
const refuse = (status, code, error, extra = {}) => NextResponse.json({ code, error, ...extra }, { status });

/**
 * Register a signed permission on-chain with approveWithSignature, then store it.
 *
 * Two signing paths:
 *   base_account -- the Base Account SDK returns a signature the account already accepts.
 *   eoa_owned    -- an injected wallet signed CoinbaseSmartWalletMessage{hash} for a smart
 *                   account it owns. The server builds the ERC-6492 signature itself, so the
 *                   account is created, the manager made an owner, and the permission approved
 *                   in one transaction the executor pays for.
 *
 * Order matters: every check that costs nothing runs before anything that costs gas,
 * and the transaction is simulated before it is sent.
 */
export async function POST(req) {
  if (!process.env.EXECUTOR_PRIVATE_KEY) {
    return refuse(503, 'registration_unavailable',
      'Registration is not enabled on this deployment. It needs the executor key, which is deliberately not configured here.');
  }
  const pol = policy();
  const pub = publicClient();
  const now = Math.floor(Date.now() / 1000);

  // Registrations must never spend gas that charges already owed will need.
  const tank = await readGasTank(pub, pol.executor).catch(() => null);
  if (tank && !tank.registrationOpen) {
    return refuse(503, 'gas_tank_low',
      'Registration is paused: the executor that pays for it is low on gas. Nothing was signed on-chain; please try again later.');
  }

  let body;
  try { body = await req.json(); } catch { return refuse(400, 'bad_request', 'body is not JSON'); }
  const path = body.path;
  if (path !== 'eoa_owned' && path !== 'base_account') return refuse(400, 'bad_request', 'path must be "eoa_owned" or "base_account"');
  const m = body.permission;
  if (!m || !isAddress(m.account ?? '')) return refuse(400, 'bad_request', 'permission.account is missing or not an address');

  let permission;
  try {
    permission = toStruct({ ...m, salt: isHex(m.salt) ? hexToBigInt(m.salt) : m.salt });
  } catch (e) { return refuse(400, 'bad_request', `permission is malformed: ${e.shortMessage ?? e.message}`); }

  // 1. Policy: the terms must be exactly the ones this deployment offers.
  const violation = checkPolicy(permission, pol, now);
  if (violation) return refuse(400, 'policy', `${violation.field} is not what this deployment offers`, violation);

  // 2. The hash is recomputed on-chain, never taken from the client.
  const permissionHash = await pub.readContract({
    address: pol.manager, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [permission] });
  if (!body.permissionHash || body.permissionHash.toLowerCase() !== permissionHash.toLowerCase()) {
    return refuse(400, 'hash_mismatch', 'the permission hash the page showed does not match the terms submitted',
      { client: body.permissionHash ?? null, server: permissionHash });
  }

  // 3. Path-specific: who signed, and whether that signature can possibly validate.
  let signature = body.signature, signerEoa = null, accountHadCode = null;
  if (path === 'eoa_owned') {
    if (!isAddress(body.signerEoa ?? '')) return refuse(400, 'bad_request', 'signerEoa is missing or not an address');
    signerEoa = getAddress(body.signerEoa);

    // The account must be the one this EOA derives -- EOA and manager as owners, nonce 0.
    const derived = await deriveSmartAccount(pub, signerEoa, pol.manager);
    if (derived.toLowerCase() !== permission.account.toLowerCase()) {
      return refuse(400, 'account_mismatch', `the account in the permission is not the smart account ${signerEoa} owns`,
        { expected: derived, got: permission.account });
    }

    // The owner, from the chain: a plain EOA, or a 7702 account delegating to a delegate that has been
    // verified and pinned by code hash (TRUSTED_7702_DELEGATES). Anything else is refused before any gas.
    // The page checks first; this checks again in case the account changed in between.
    const owner = await checkOwner(pub, signerEoa);
    if (!owner.accepted) {
      if (owner.reason === 'delegate_code_changed') {
        return refuse(409, 'delegate_code_changed', "This account delegates to MetaMask's delegator, but the code at that address no longer matches the version that was verified. It is refused until it has been reviewed again.", { delegate: owner.delegate, expected: owner.expected, got: owner.got });
      }
      if (owner.reason === 'eip7702') {
        return refuse(409, 'eip7702', 'This account has been upgraded to a smart account (EIP-7702) that delegates to a contract this deployment does not trust to check signatures. Use a standard account, or the Base Account option.', { delegate: owner.delegate });
      }
      return refuse(409, 'contract_owner', 'This address is a contract, not a standard account. A smart contract wallet cannot own the account this flow creates. Pay by transfer instead.');
    }

    if (!isHex(signature ?? '') || size(signature) !== 65) {
      return refuse(400, 'signature_format', 'expected the 65-byte signature your wallet returned for the typed data');
    }

    // Local recovery first: free, and it lets the refusal say what actually went wrong.
    const td = smartWalletTypedData(permission.account, pol.chainId, permissionHash);
    const recovered = await recoverTypedDataAddress({ ...td, signature }).catch(() => null);
    if (recovered?.toLowerCase() !== signerEoa.toLowerCase()) {
      const same = async (p) => (await p.catch(() => null))?.toLowerCase() === signerEoa.toLowerCase();
      let code = 'not_owner', error = `This signature was not made by ${signerEoa}, the owner of this account.`;
      if (await same(recoverMessageAddress({ message: { raw: permissionHash }, signature }))) {
        code = 'personal_sign'; error = 'This was signed as a plain message (personal_sign). The account only accepts the typed-data signature.';
      } else if (await same(recoverAddress({ hash: permissionHash, signature }))) {
        code = 'unwrapped_hash'; error = "This signs the bare permission hash, without the account's replay-safe wrapper. It would be valid for any account, so it is refused.";
      } else if (await same(recoverTypedDataAddress({ ...td, domain: { ...td.domain, version: '2' }, signature }))) {
        code = 'wrong_domain'; error = 'This was signed under the wrong domain version. The account expects "Coinbase Smart Wallet", version 1.';
      }
      return refuse(400, code, error);
    }

    const accountCode = await pub.getCode({ address: permission.account });
    accountHadCode = !!accountCode && accountCode !== '0x';
    signature = registrationSignature(signerEoa, pol.manager, signature);
  } else if (!isHex(signature ?? '')) {
    return refuse(400, 'signature_format', 'signature is missing');
  }

  // 4. Already registered: idempotent, no transaction, no new row.
  const already = await pub.readContract({
    address: pol.manager, abi: spendPermissionManagerAbi, functionName: 'isApproved', args: [permission] });
  if (already) {
    const row = (await query('SELECT id, approved_tx_hash FROM permissions WHERE permission_hash = $1', [permissionHash])).rows[0];
    if (row) return NextResponse.json({ permissionId: String(row.id), permissionHash, alreadyRegistered: true, approveTx: row.approved_tx_hash });
  }

  // 5. Rate limits -- only now, because only past this point do we spend gas.
  const ipHash = ipHashFrom(req);
  if (!already) {
    const L = pol.limits;
    if (signerEoa) {
      const recent = (await query(`SELECT count(*)::int AS c FROM permissions
         WHERE lower(signer_eoa) = lower($1) AND created_at > now() - make_interval(secs => $2)`, [signerEoa, L.perSignerSeconds])).rows[0].c;
      if (recent > 0) return refuse(429, 'rate_limited', `This account registered a permission in the last ${L.perSignerSeconds / 60} minutes. Try again later.`);
    }
    const fromIp = (await query(`SELECT count(*)::int AS c FROM permissions
       WHERE registration_ip_hash = $1 AND created_at > now() - interval '1 hour'`, [ipHash])).rows[0].c;
    if (fromIp >= L.perIpPerHour) return refuse(429, 'rate_limited', `Too many registrations from this network in the last hour (limit ${L.perIpPerHour}).`);
    const total = (await query(`SELECT count(*)::int AS c FROM permissions
       WHERE signing_path IS NOT NULL AND created_at > now() - interval '1 hour'`)).rows[0].c;
    if (total >= L.globalPerHour) return refuse(429, 'rate_limited', 'Registration is at its hourly limit. Try again later.');
  }

  // 6. Simulate, then send. A signature that would not validate costs nothing.
  let approvedTxHash = null;
  if (!already) {
    const executor = privateKeyToAccount(process.env.EXECUTOR_PRIVATE_KEY);
    try {
      await pub.simulateContract({ address: pol.manager, abi: spendPermissionManagerAbi,
        functionName: 'approveWithSignature', args: [permission, signature], account: executor });
    } catch (e) {
      return refuse(400, 'rejected_onchain', `The permission manager would reject this signature: ${e.shortMessage ?? e.message}`);
    }
    const wallet = createWalletClient({ account: executor, chain: baseSepolia, transport: http(config().rpcUrl) });
    const send = () => wallet.writeContract({ address: pol.manager, abi: spendPermissionManagerAbi,
      functionName: 'approveWithSignature', args: [permission, signature] });
    try {
      approvedTxHash = await send();
    } catch (e) {
      // The executor has a second sender -- the charger, which allocates its own nonces.
      // If ours was taken in between, the node rejects it before the mempool; one retry
      // with a fresh nonce resolves it. Anything else, or a second failure, is refused
      // cleanly: a rejected send means no transaction and no row.
      const m = e?.shortMessage ?? e?.message ?? String(e);
      if (!/nonce/i.test(m)) return refuse(502, 'send_failed', `The registration could not be sent: ${m}`);
      try { approvedTxHash = await send(); }
      catch (e2) { return refuse(502, 'send_failed', `The registration could not be sent: ${e2?.shortMessage ?? e2?.message ?? e2}`); }
    }
    const r = await pub.waitForTransactionReceipt({ hash: approvedTxHash });
    if (r.status !== 'success') {
      return NextResponse.json({ code: 'reverted', error: 'approveWithSignature reverted after simulation passed', tx: approvedTxHash }, { status: 502 });
    }
  }

  const id = await storePermission({ ...permission, permissionHash, signature, approvedTxHash,
    signingPath: path, signerEoa, ipHash });

  return NextResponse.json({
    permissionId: String(id),
    permissionHash,
    signingPath: path,
    signerEoa,
    account: permission.account,
    accountCreatedByThisTx: accountHadCode === false,
    approveTx: approvedTxHash,
    explorer: approvedTxHash ? `https://sepolia.basescan.org/tx/${approvedTxHash}` : null,
    gasPaidBy: 'retainer executor (the signer paid nothing)',
  });
}
