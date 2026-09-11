/**
 * The single-worker lease and the pinned "superseded" decision, each with the failure it
 * exists to prevent shown happening to it.
 *
 * Uses throwaway lease names, so it never touches the live worker's lease, and reads only
 * public chain state. Safe to run while the hosted worker is running.
 *
 *   node --env-file=.env scripts/check-lease.mjs
 */
import { publicClient, config } from '@retainer/chain';
import { query, close } from '@retainer/db';
import { acquireLease, releaseLease, assertLease, heldLease, LeaseError } from '../apps/worker/src/lease.js';
import { claimCharge } from '../apps/worker/src/charger.js';
import { spentByBlock } from '../apps/worker/src/recovery.js';
import { tx } from '@retainer/db';

let pass = 0, fail = 0;
const EXPECTED = 16;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = `check-${Date.now()}`;
const L1 = `${RUN}-a`, L2 = `${RUN}-b`;
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

try {
  console.log('=== who may hold a lease ===');
  check('A takes a free lease', await acquireLease(L1, 'A'));
  check('B cannot take it while A holds it', !(await acquireLease(L1, 'B')));
  check('A can renew it', await acquireLease(L1, 'A'));
  await releaseLease(L1, 'A');
  check('after A releases it, B takes it at once', await acquireLease(L1, 'B'));
  await releaseLease(L1, 'B');

  check('C takes a lease with a 1 s lifetime', await acquireLease(L2, 'C', 1));
  check('D cannot take it before it lapses', !(await acquireLease(L2, 'D')));
  await sleep(1600);
  check('D takes it once it has lapsed (a crashed holder blocks only until then)', await acquireLease(L2, 'D'));
  await releaseLease(L2, 'D');

  console.log('\n=== the fence inside transactions ===');
  check('A holds a fresh lease', await acquireLease(L1, 'A'));
  check('holding it, the fence passes', !(await rejects(tx((c) => assertLease(c)))));
  check('holding it, a claim runs (charge 999999999 does not exist, so nothing is claimed)', (await claimCharge('999999999')) === null);
  await query('UPDATE worker_lease SET holder = $2 WHERE name = $1', [L1, 'intruder']);   // someone else took over
  const e1 = await rejects(tx((c) => assertLease(c)));
  check('once another holder has it, the fence throws', e1 instanceof LeaseError, e1?.message);
  const e2 = await rejects(claimCharge('999999999'));
  check('and a claim is refused before it reads a single charge', e2 instanceof LeaseError, e2?.message);
  await query('DELETE FROM worker_lease WHERE name = $1', [L1]);
  await acquireLease(L1, 'A'); await releaseLease(L1, 'A');
  check('a process holding no lease is refused outright (fails closed)', heldLease() === null && (await rejects(tx((c) => assertLease(c)))) instanceof LeaseError);

  console.log('\n=== "superseded" is decided at one block ===');
  const pub = publicClient(), cfg = config();
  const B = await pub.getBlockNumber();
  const real = (await query(`SELECT a.tx_hash, a.signed_at FROM charge_attempts a WHERE a.charge_id = 20`)).rows[0];
  check('a charge that landed (#20) is found by its logs up to B', (await spentByBlock(pub, cfg, real, B)) === true, real.tx_hash.slice(0, 12));
  const fake = { tx_hash: '0x' + 'ab'.repeat(32), signed_at: new Date(Date.now() - 10 * 60_000) };
  check('a transaction that moved nothing is not', (await spentByBlock(pub, cfg, fake, B)) === false);
  const e3 = await rejects(spentByBlock(pub, cfg, fake, B + 1_000_000n));
  check('asked about a block no node has, it throws rather than answering "not spent"', !!e3, (e3?.shortMessage ?? e3?.message ?? '').slice(0, 70));
} catch (e) {
  check(`the check crashed: ${e?.stack ?? e}`, false);
} finally {
  await query('DELETE FROM worker_lease WHERE name LIKE $1', [`${RUN}%`]).catch(() => {});
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await close(); process.exit(fail ? 1 : 0);
}
