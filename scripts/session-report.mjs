/**
 * The chain-and-database side of one customer's session, as a table of hashes.
 *
 *   npm run session:report -- --signer 0xTheirMetaMaskAddress
 *
 * For every permission that EOA registered: the registration transaction (and whether
 * it created the smart account), each USDC transfer into the smart account, each
 * charge and what reached the treasury, and the revocation if there was one. Every
 * figure is read from the chain or from our records at the time of running; nothing
 * is inferred.
 */
import { parseAbi, parseEventLogs, getAddress } from 'viem';
import { publicClient, config, classifyOwnerCode } from '@retainer/chain';
import { query, close } from '@retainer/db';

const i = process.argv.indexOf('--signer');
if (i < 0) { console.error('usage: npm run session:report -- --signer 0x...'); process.exit(2); }
const signer = getAddress(process.argv[i + 1]);
const pub = publicClient(), cfg = config();
const scan = (h) => `https://sepolia.basescan.org/tx/${h}`;
const usdc = (v) => (Number(v) / 1e6).toFixed(6);
const TRANSFER = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const ROUTED = parseAbi(['event SpendRouted(address indexed account, address indexed executor, address indexed recipient, bytes32 permissionHash, address token, uint256 value)']);

const perms = (await query(
  `SELECT * FROM permissions WHERE lower(signer_eoa) = lower($1) ORDER BY id`, [signer])).rows;
console.log(`signer ${signer} — owner code now: ${classifyOwnerCode(await pub.getCode({ address: signer })).kind}`);
if (!perms.length) { console.log('no permissions registered by this signer'); await close(); process.exit(0); }

for (const p of perms) {
  console.log(`\npermission #${p.id}  ${p.permission_hash}`);
  console.log(`  smart account     ${p.account}`);
  console.log(`  terms             ${usdc(p.allowance)} USDC / ${p.period_seconds}s, ${new Date(p.start_ts * 1000).toISOString()} -> ${new Date(p.end_ts * 1000).toISOString()}`);

  const reg = await pub.getTransactionReceipt({ hash: p.approved_tx_hash });
  const before = await pub.getCode({ address: p.account, blockNumber: reg.blockNumber - 1n });
  console.log(`  registered        ${reg.status} @${reg.blockNumber}  ${scan(p.approved_tx_hash)}`);
  console.log(`                    ${!before || before === '0x' ? 'created the smart account in the same transaction' : 'smart account already existed'}; gas paid by ${reg.from.toLowerCase() === cfg.executor.toLowerCase() ? 'the Retainer executor' : reg.from}`);

  // Every USDC transfer into the smart account since registration's block minus a margin.
  const logs = await pub.getLogs({ address: cfg.usdc, event: TRANSFER[0], args: { to: p.account }, fromBlock: reg.blockNumber - 5000n, toBlock: 'latest' });
  for (const l of logs) console.log(`  funded            ${usdc(l.args.value)} USDC from ${l.args.from}  ${scan(l.transactionHash)}`);
  if (!logs.length) console.log('  funded            — no USDC has been sent to the smart account');

  const charges = (await query(`SELECT id, state::text AS state, confirmed_tx_hash, confirmed_amount FROM charges WHERE permission_id = $1 ORDER BY id`, [p.id])).rows;
  for (const c of charges) {
    if (!c.confirmed_tx_hash) { console.log(`  charge #${c.id}         ${c.state} (not on-chain yet)`); continue; }
    const r = await pub.getTransactionReceipt({ hash: c.confirmed_tx_hash });
    const routed = parseEventLogs({ abi: ROUTED, logs: r.logs }).find((e) => e.args.permissionHash.toLowerCase() === p.permission_hash.toLowerCase());
    console.log(`  charge #${c.id}         ${c.state}, ${usdc(c.confirmed_amount)} USDC  ${scan(c.confirmed_tx_hash)}`);
    console.log(`                    SpendRouted: ${routed ? `${usdc(routed.args.value)} USDC to ${routed.args.recipient}${routed.args.recipient.toLowerCase() === cfg.treasury.toLowerCase() ? ' (the treasury)' : ''}` : 'NOT FOUND in receipt'}`);
  }
  if (!charges.length) console.log('  charge            — none enqueued');
  console.log(`  revoked           ${p.revoked_tx_hash ? scan(p.revoked_tx_hash) : '— not revoked'}`);
}
await close();
