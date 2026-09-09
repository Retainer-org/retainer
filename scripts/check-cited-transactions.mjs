/**
 * Every 32-byte hash the site, the docs or the README cites is checked against
 * what the citing text actually claims about it:
 *
 *   - a transaction        -> must resolve on Base Sepolia, status success
 *   - the crash-B attempt  -> must NOT resolve; it is cited as never mined
 *   - the EIP-712 typehash -> must equal SPEND_PERMISSION_TYPEHASH on the
 *                             deployed manager, which is the claim PROVENANCE
 *                             makes about it
 *   - a permission hash    -> not a transaction; identified from the database
 *
 * Checking only that "the hashes resolve" would pass while the page lied about
 * the one that must not, so the opposite claims are asserted separately.
 *
 * Run: npm run check:txs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { publicClient, config } from '@retainer/chain';
import { query, close } from '@retainer/db';

const pub = publicClient();
const cfg = config();
let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };

const NEVER_MINED = '0x0a078798bcc3d5c5947a4c21687fed79a79332c1521b4b4900d62bfd2e9131a3';
const TYPEHASH    = '0xc9fa0f0252014cf89ab0539e3bb3adcb76f93e6bb6494e8cc61c14e2761ee2e4';
const EVIDENCE    = 'apps/web/components/evidence.tsx';

const files = execSync(`git grep -lE '0x[0-9a-fA-F]{64}' -- '*.md' '*.tsx' '*.ts'`, { encoding: 'utf8' }).trim().split('\n');
const cited = new Map();
for (const f of files)
  for (const m of readFileSync(f, 'utf8').matchAll(/0x[0-9a-fA-F]{64}/g)) {
    const h = m[0].toLowerCase();
    if (!cited.has(h)) cited.set(h, new Set());
    cited.get(h).add(f);
  }

const permissionHashes = new Set(
  (await query(`SELECT permission_hash FROM permissions`)).rows.map((r) => r.permission_hash.toLowerCase()));

console.log(`=== ${cited.size} distinct hashes cited across ${files.length} files ===`);
let evidenceResolved = 0, skipped = 0;
for (const [h, whereSet] of [...cited].sort()) {
  const where = [...whereSet];
  if (permissionHashes.has(h)) { skipped++; continue; }

  if (h === TYPEHASH) {
    const onchain = await pub.readContract({
      address: cfg.manager, functionName: 'SPEND_PERMISSION_TYPEHASH', args: [],
      abi: [{ type: 'function', name: 'SPEND_PERMISSION_TYPEHASH', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' }],
    }).catch(() => null);
    check('the vendored typehash still equals SPEND_PERMISSION_TYPEHASH on the deployed manager',
      onchain?.toLowerCase() === h, where.join(', '));
    continue;
  }

  const r = await pub.getTransactionReceipt({ hash: h }).catch(() => null);
  if (h === NEVER_MINED) {
    check('the transaction cited as never mined still does not exist', r === null, where.join(', '));
    continue;
  }
  const ok = !!r && r.status === 'success';
  if (ok && whereSet.has(EVIDENCE)) evidenceResolved++;
  check(`${h.slice(0, 12)}… resolves (block ${r?.blockNumber ?? '-'}, ${r?.status ?? 'MISSING'})`, ok, where.join(', '));
}

check('the landing page evidence still resolves 7 transactions', evidenceResolved === 7, `${evidenceResolved} resolved`);
console.log(`  (${skipped} permission hashes skipped — not transactions)`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await close();
process.exit(fail ? 1 : 0);
