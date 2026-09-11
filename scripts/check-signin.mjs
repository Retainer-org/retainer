/**
 * Customer sign-in, against any deployment, over the API.
 *
 * The six ways sign-in must refuse -- another key's signature, a replayed nonce, an expired
 * nonce, the wrong origin, a tampered cookie, and one customer's cookie asking for another's
 * data -- each shown beside the same request done right, so every refusal is seen to be a
 * refusal and not a request that could never have worked. Then the two-wallet test: each
 * signed-in customer gets exactly their own permissions (compared with the database), and a
 * wallet with none gets none. And the address-listing route is confirmed closed.
 *
 *   WEB_BASE_URL=https://retainer-one.vercel.app SIGNIN_KEY_A=<file> SIGNIN_KEY_B=<file> \
 *     node --env-file=.env scripts/check-signin.mjs
 *
 * A and B must each have registered at least one permission. Uses the shared database only to
 * age one nonce (the expired case) and to know the right answer.
 */
import { readFileSync } from 'node:fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { signInTypedData } from '@retainer/chain';
import { query, close } from '@retainer/db';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const ORIGIN = new URL(BASE).origin;
const EVIL = 'https://evil.example';
const A = privateKeyToAccount(readFileSync(process.env.SIGNIN_KEY_A, 'utf8').trim());
const B = privateKeyToAccount(readFileSync(process.env.SIGNIN_KEY_B, 'utf8').trim());
const C = privateKeyToAccount(generatePrivateKey());

let pass = 0, fail = 0;
const EXPECTED = 17;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };

const post = (path, body, origin = ORIGIN, cookie) => fetch(BASE + path, { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
async function nonceFor(account, origin = ORIGIN) { const r = await post('/api/session/nonce', { address: account.address }, origin); return { status: r.status, ...(await json(r)) }; }
const sign = (fields, signer) => signer.signTypedData(signInTypedData(fields));
async function signIn(fields, signature, origin = ORIGIN) {
  const r = await post('/api/session', { nonce: fields.nonce, signature }, origin);
  const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('retainer_session=')) ?? null;
  return { status: r.status, cookie, ...(await json(r)) };
}
async function me(cookie, qs = '') {
  const r = await fetch(`${BASE}/api/me/permissions${qs}`, { headers: cookie ? { cookie } : {} });
  return { status: r.status, ...(await json(r)) };
}
const dbIds = async (a) => (await query('SELECT id FROM permissions WHERE lower(signer_eoa) = lower($1) ORDER BY id', [a])).rows.map((r) => String(r.id));
const ids = (m) => (m.permissions ?? []).map((p) => p.id).sort((x, y) => Number(x) - Number(y));

try {
  console.log(`${BASE}\n\n=== the address-listing route is closed ===`);
  const old = await fetch(`${BASE}/api/permissions?signer=${B.address}`); const oj = await json(old);
  check('?signer=<someone else> returns 410 and no permissions', old.status === 410 && !('permissions' in oj), `${old.status} ${oj.code}`);

  console.log('\n=== 1. a signature by another key ===');
  const f1 = await nonceFor(A);
  const r1 = await signIn(f1, await sign(f1, B));
  check("A's sign-in request signed by B's key is refused", r1.status === 401 && r1.code === 'bad_signature' && !r1.cookie, `${r1.status} ${r1.code}`);
  const fA = await nonceFor(A); const sigA = await sign(fA, A);
  const rA = await signIn(fA, sigA);
  check('control: the same request signed by A signs A in, with an HTTP-only cookie', rA.status === 200 && !!rA.cookie, `${rA.status} ${rA.address}`);

  console.log('\n=== 2. a replayed nonce ===');
  const r2 = await signIn(fA, sigA);
  check("replaying A's exact, valid signature is refused", r2.status === 409 && r2.code === 'nonce_used' && !r2.cookie, `${r2.status} ${r2.code}`);

  console.log('\n=== 3. an expired nonce ===');
  const f3 = await nonceFor(A);
  await query('UPDATE session_nonces SET expires_at = issued_at - 1 WHERE nonce = $1', [f3.nonce]);
  const r3 = await signIn(f3, await sign(f3, A));
  check('a correctly signed request whose nonce has expired is refused', r3.status === 401 && r3.code === 'nonce_expired' && !r3.cookie, `${r3.status} ${r3.code}`);

  console.log('\n=== 4. the wrong origin ===');
  const f4a = await nonceFor(A, EVIL);
  check('a nonce requested from another site is refused', f4a.status === 403 && f4a.code === 'bad_origin', `${f4a.status} ${f4a.code}`);
  const f4b = await nonceFor(A);
  const r4b = await signIn(f4b, await sign(f4b, A), EVIL);
  check('a valid signature presented from another site is refused', r4b.status === 403 && r4b.code === 'bad_origin' && !r4b.cookie, `${r4b.status} ${r4b.code}`);
  const f4c = await nonceFor(A, null);
  check('a request with no Origin at all is refused', f4c.status === 403 && f4c.code === 'bad_origin', `${f4c.status} ${f4c.code}`);

  console.log('\n=== 5. a tampered cookie ===');
  const [payload, mac] = rA.cookie.slice('retainer_session='.length).split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const swapped = Buffer.from(JSON.stringify({ ...body, a: B.address.toLowerCase() })).toString('base64url');
  const m5a = await me(`retainer_session=${swapped}.${mac}`);
  check("A's cookie rewritten to say B is refused", m5a.status === 401 && !m5a.permissions, `${m5a.status} ${m5a.code}`);
  const flipped = mac.slice(0, -2) + (mac.slice(-2) === 'AA' ? 'AB' : 'AA');
  const m5b = await me(`retainer_session=${payload}.${flipped}`);
  check("A's cookie with its MAC altered is refused", m5b.status === 401 && !m5b.permissions, `${m5b.status} ${m5b.code}`);
  const m5c = await me(rA.cookie);
  check("control: A's cookie, untouched, is accepted", m5c.status === 200 && m5c.address === A.address.toLowerCase());

  console.log("\n=== 6. A's cookie asking for B's data ===");
  const bIds = await dbIds(B.address), aIds = await dbIds(A.address);
  const m6 = await me(rA.cookie, `?address=${B.address}&signer=${B.address}&account=${B.address}`);
  check("with A's cookie, naming B in every parameter still returns A's permissions and none of B's",
    m6.status === 200 && m6.address === A.address.toLowerCase() && ids(m6).every((i) => !bIds.includes(i)) && ids(m6).join() === aIds.join(),
    `got [${ids(m6)}], B has [${bIds}]`);

  console.log('\n=== two wallets, and a stranger ===');
  const fB = await nonceFor(B); const rB = await signIn(fB, await sign(fB, B));
  const mA = await me(rA.cookie), mB = await me(rB.cookie);
  check("A sees exactly A's permissions", ids(mA).join() === aIds.join() && aIds.length > 0, `[${ids(mA)}] = db [${aIds}]`);
  check("B sees exactly B's permissions", ids(mB).join() === bIds.join() && bIds.length > 0, `[${ids(mB)}] = db [${bIds}]`);
  check('and the two lists share nothing', ids(mA).every((i) => !ids(mB).includes(i)));
  const fC = await nonceFor(C); const rC = await signIn(fC, await sign(fC, C));
  const mC = await me(rC.cookie);
  check('a fresh wallet with no permissions signs in and sees none', rC.status === 200 && mC.status === 200 && ids(mC).length === 0, `[${ids(mC)}]`);
  const none = await me(null);
  check('with no cookie, nothing is served', none.status === 401 && !none.permissions, `${none.status} ${none.code}`);
} catch (e) {
  check(`the check crashed: ${e?.stack ?? e}`, false);
} finally {
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await close(); process.exit(fail ? 1 : 0);
}
