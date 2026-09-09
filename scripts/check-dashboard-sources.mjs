/**
 * The dashboard's standing claim is that the words match reality. The way that
 * claim rots is a page changing its loader while its copy keeps describing the
 * old source -- which is exactly what happened when charges, failures and
 * reconciliation moved to a database-only loader and the shell still said every
 * row came from "the database and the chain".
 *
 * So: assert that each page's declared source is the source it actually uses.
 * A page reads the chain if and only if it calls loadSnapshot, the one loader
 * that multicalls the SpendPermissionManager.
 *
 * Run: npm run check:sources
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'apps/web/app/dashboard';
const CHAIN_LOADER = 'loadSnapshot';
let pass = 0, fail = 0;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };

const routes = readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(DIR, e.name, 'page.tsx')))
  .map((e) => ({ name: e.name, src: readFileSync(join(DIR, e.name, 'page.tsx'), 'utf8') }));

console.log(`=== ${routes.length} dashboard routes ===`);
for (const r of routes) {
  const declared = r.src.match(/reads="(db\+chain|db)"/)?.[1];
  const actual = r.src.includes(CHAIN_LOADER) ? 'db+chain' : 'db';
  check(`/${r.name} declares its source`, !!declared, declared ?? 'missing reads= prop');
  if (declared) check(`/${r.name} declares ${declared}, and ${actual === 'db+chain' ? 'does' : 'does not'} call ${CHAIN_LOADER}`,
    declared === actual, `declared ${declared}, actual ${actual}`);
}

// Only the review queue may write. Server actions are the only write path.
const actionFiles = routes.filter((r) => existsSync(join(DIR, r.name, 'actions.ts')));
check('exactly one route ships server actions, and it is the review queue',
  actionFiles.length === 1 && actionFiles[0].name === 'review', actionFiles.map((a) => a.name).join(',') || 'none');
// `writes` may be bare or bound to the env gate (writes={canWrite}); either
// way it marks the route as having a write path at all.
const WRITES = /\swrites(?:[\s/>]|=)/;
check('the review page is the only one marked as writing',
  routes.filter((r) => WRITES.test(r.src)).map((r) => r.name).join(',') === 'review',
  routes.filter((r) => WRITES.test(r.src)).map((r) => r.name).join(',') || 'none');

// Negative control: the invariant must be violable, or it proves nothing.
const ctl = { name: 'control', src: 'const x = <PageHeader title="t" reads="db" sub="s" />; loadSnapshot();' };
const cDecl = ctl.src.match(/reads="(db\+chain|db)"/)?.[1];
const cActual = ctl.src.includes(CHAIN_LOADER) ? 'db+chain' : 'db';
check('negative control: a page claiming "db" while calling loadSnapshot is detected', cDecl !== cActual, `${cDecl} vs ${cActual}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
