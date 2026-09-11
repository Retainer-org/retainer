/**
 * Billing links, against any deployment: what a link offers is exactly what gets registered.
 *
 * Creates its own fixture links (named "check-links fixture"), then shows, each beside a
 * request that succeeds or with the executor's nonce as witness:
 *   - every link state answers plainly, through the API and at registration;
 *   - every term a caller could tamper with is refused against the link's own terms;
 *   - a permission built from link A and presented with link B's token is refused, and the
 *     same permission with link A's token is accepted (the negative control);
 *   - without a link, registration is refused on a public deployment;
 *   - a first charge at signup needs the smart account funded first;
 *   - two customers racing for a single-use link: exactly one registers;
 *   - the progress receipt returns its own permission and cannot be made to return another.
 * Refusals are proven to send nothing: the executor's pending nonce is unchanged across them.
 *
 *   WEB_BASE_URL=... node --env-file=.env scripts/check-links.mjs
 * Prints the fixture tokens so the stranger pass can look at each state's page.
 */
import { randomBytes, createHmac } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { getAddress } from 'viem';
import { publicClient, config, toStruct, deriveSmartAccount, smartWalletTypedData, spendPermissionManagerAbi, encodeExtraData } from '@retainer/chain';
import { query, close } from '@retainer/db';

const BASE = process.env.WEB_BASE_URL || 'http://localhost:3017';
const PUBLIC = !/localhost|127\.0\.0\.1/.test(BASE);
const cfg = config(), pub = publicClient();
const TREASURY = getAddress(process.env.MERCHANT_TREASURY_ADDRESS);
const OTHER_TREASURY = getAddress(process.env.TEST_USER_ADDRESS);

let pass = 0, fail = 0;
const EXPECTED = 28;
const check = (l, ok, d = '') => { ok ? pass++ : fail++; console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${l}${d ? ` — ${d}` : ''}`); };
const ser = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
const json = async (r) => { try { return await r.json(); } catch { return {}; } };
const nonce = () => pub.getTransactionCount({ address: cfg.executor, blockTag: 'pending' });

async function fixture({ allowance = 2_000_000n, treasury = TREASURY, first = 'none', firstAmount = null, singleUse = false, expired = false, revoked = false }) {
  const token = randomBytes(16).toString('base64url');
  await query(`INSERT INTO billing_links (token, merchant_name, treasury, chain_id, allowance, period_seconds, duration_seconds,
                 first_charge, first_charge_amount, expires_at, single_use, revoked_at, created_by)
               VALUES ($1,'check-links fixture',$2,$3,$4,86400,2592000,$5,$6, now() + ($7 || ' days')::interval, $8, $9, 'check-links')`,
    [token, treasury, cfg.chainId, allowance.toString(), first, firstAmount?.toString() ?? null, expired ? '-1' : '30', singleUse, revoked ? new Date() : null]);
  return token;
}
const view = async (token) => { const r = await fetch(`${BASE}/api/links/${token}`); return { status: r.status, ...(await json(r)) }; };

/** A validly signed registration built from a link's own terms, with any term optionally changed (and re-hashed). */
async function signed(signer, pol, change = {}) {
  const account = await deriveSmartAccount(pub, signer.address, cfg.manager);
  const start = pol.fixedStart ?? Math.floor(Date.now() / 1000);
  const s = toStruct({ account, spender: pol.router, token: pol.usdc, allowance: pol.allowance, period: pol.periodSeconds,
    start, end: start + pol.durationSeconds, salt: BigInt('0x' + randomBytes(16).toString('hex')), extraData: pol.extraData, ...change });
  const permissionHash = await pub.readContract({ address: cfg.manager, abi: spendPermissionManagerAbi, functionName: 'getHash', args: [s] });
  const signature = await signer.signTypedData(smartWalletTypedData(account, cfg.chainId, permissionHash));
  return { path: 'eoa_owned', signerEoa: signer.address, permission: ser(s), permissionHash, signature };
}
const register = async (body) => { const r = await fetch(`${BASE}/api/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, ...(await json(r)) }; };
const progress = async (qs) => { const r = await fetch(`${BASE}/api/pay/progress?${qs}`); return { status: r.status, ...(await json(r)) }; };

const tokens = {};
try {
  console.log(`${BASE} (${PUBLIC ? 'public' : 'local'})\n\n=== link states, through the API ===`);
  tokens.ok = await fixture({});
  tokens.other = await fixture({ allowance: 3_000_000n, treasury: OTHER_TREASURY });
  tokens.single = await fixture({ singleUse: true });
  tokens.signup = await fixture({ first: 'at_signup', firstAmount: 1_000_000n });
  tokens.expired = await fixture({ expired: true });
  tokens.revoked = await fixture({ revoked: true });
  tokens.missing = 'noSuchLink_' + randomBytes(8).toString('base64url');
  const vOk = await view(tokens.ok), vOther = await view(tokens.other);
  check('a valid link returns its own terms: cap and payee from the row', vOk.state === 'valid' && vOk.policy.allowance === '2000000' && vOk.policy.treasury === TREASURY
    && vOther.policy.allowance === '3000000' && vOther.policy.treasury === OTHER_TREASURY);
  check('an unknown token is 404', (await view(tokens.missing)).status === 404);
  check('an expired link says expired, and offers no terms', (await view(tokens.expired)).state === 'expired' && !(await view(tokens.expired)).policy);
  check('a revoked link says revoked, and offers no terms', (await view(tokens.revoked)).state === 'revoked' && !(await view(tokens.revoked)).policy);

  console.log('\n=== refusals: every one before anything is sent ===');
  const n0 = await nonce();
  const S = privateKeyToAccount(generatePrivateKey());
  const good = await signed(S, vOk.policy);
  for (const [name, token, status, code] of [['an unknown', tokens.missing, 404, 'link_not_found'], ['an expired', tokens.expired, 410, 'link_expired'], ['a revoked', tokens.revoked, 410, 'link_revoked']]) {
    const r = await register({ ...good, link: token });
    check(`registering through ${name} link is refused`, r.status === status && r.code === code, `${r.status} ${r.code}`);
  }
  const P = vOk.policy, now = Math.floor(Date.now() / 1000);
  for (const [field, change] of [
    ['allowance', { allowance: 999_000_000n }], ['period', { period: 3600 }], ['end', { end: now + 365 * 86400 }], ['start', { start: now + 7200, end: now + 7200 + P.durationSeconds }],
    ['spender', { spender: cfg.executor }], ['extraData (payee)', { extraData: encodeExtraData(cfg.executor, OTHER_TREASURY) }], ['token', { token: cfg.router }]]) {
    const r = await register({ ...(await signed(S, P, change)), link: tokens.ok });
    check(`a permission with its ${field} changed is refused against the link's terms`, r.status === 400 && r.code === 'policy', `${r.status} ${r.code} ${r.field ?? ''}`);
  }
  // A different signer: on a local run the operator-path control below registers S, and its cooldown would refuse S again.
  const S2 = privateKeyToAccount(generatePrivateKey());
  const fromOther = await signed(S2, vOther.policy);
  const cross = await register({ ...fromOther, link: tokens.ok });
  check("link B's permission presented with link A's token is refused", cross.status === 400 && cross.code === 'policy', `${cross.status} ${cross.code} ${cross.field ?? ''}`);
  const bare = await register(good);
  check(PUBLIC ? 'without a link, registration is refused on the public deployment' : 'without a link, the local operator path still registers (control)',
    PUBLIC ? bare.status === 403 && bare.code === 'link_required' : bare.status === 200, `${bare.status} ${bare.code ?? bare.permissionId}`);
  const vSignup = await view(tokens.signup);
  const unfunded = await register({ ...(await signed(privateKeyToAccount(generatePrivateKey()), vSignup.policy)), link: tokens.signup });
  check('a first charge at signup with an empty smart account is refused: fund first', unfunded.status === 400 && unfunded.code === 'fund_first', `${unfunded.status} ${unfunded.code}`);
  const n1 = await nonce();
  check('and every refusal above sent nothing: the executor nonce is unchanged', PUBLIC ? n0 === n1 : n1 - n0 <= 1, `${n0} -> ${n1}${PUBLIC ? '' : ' (local control may add one)'}`);

  console.log("\n=== the negative control: the same permission with its own link's token ===");
  const own = await register({ ...fromOther, link: tokens.other });
  const row = own.permissionId && (await query('SELECT link_id, recipient FROM permissions WHERE id = $1', [own.permissionId])).rows[0];
  const linkOther = (await query('SELECT id FROM billing_links WHERE token = $1', [tokens.other])).rows[0];
  check("accepted with link B's token, recorded against link B, paying link B's treasury",
    own.status === 200 && String(row?.link_id) === String(linkOther.id) && getAddress(row.recipient) === OTHER_TREASURY, `${own.status} #${own.permissionId}`);

  console.log('\n=== two customers race for a single-use link ===');
  const vSingle = await view(tokens.single);
  const [A, B] = [privateKeyToAccount(generatePrivateKey()), privateKeyToAccount(generatePrivateKey())];
  const [ba, bb] = await Promise.all([signed(A, vSingle.policy), signed(B, vSingle.policy)]);
  const race = await Promise.all([register({ ...ba, link: tokens.single }), register({ ...bb, link: tokens.single })]);
  const won = race.filter((r) => r.status === 200), lost = race.filter((r) => r.status === 409 && r.code === 'link_used');
  check('exactly one registers; the other is refused as used', won.length === 1 && lost.length === 1, race.map((r) => `${r.status} ${r.code ?? r.permissionId}`).join(' | '));
  const lk = (await query('SELECT id, used_at, used_by_permission_id FROM billing_links WHERE token = $1', [tokens.single])).rows[0];
  const fromSingle = (await query('SELECT count(*)::int c FROM permissions WHERE link_id = $1', [lk.id])).rows[0].c;
  check('one permission carries the link, and the link records it as its one use', fromSingle === 1 && String(lk.used_by_permission_id) === String(won[0]?.permissionId), `rows ${fromSingle}, used by #${lk.used_by_permission_id}`);
  check('the link now says used', (await view(tokens.single)).state === 'used');

  console.log('\n=== the progress receipt: its own permission, and nothing else ===');
  const R = own.receipt;
  const mine = await progress(`receipt=${encodeURIComponent(R)}`);
  check('the receipt returns the permission it was issued for', mine.status === 200 && mine.permissionId === String(own.permissionId), `#${mine.permissionId}`);
  const extra = await progress(`receipt=${encodeURIComponent(R)}&permission=${won[0].permissionId}&signer=${A.address}&address=${A.address}&id=1`);
  check('naming another permission or address in any parameter changes nothing', extra.permissionId === String(own.permissionId));
  const [payload, mac] = R.split('.');
  const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), p: String(won[0].permissionId) })).toString('base64url');
  check("the receipt rewritten to name another permission is refused", (await progress(`receipt=${swapped}.${mac}`)).status === 401);
  check('a receipt with its MAC altered is refused', (await progress(`receipt=${payload}.${mac.slice(0, -2)}${mac.endsWith('AA') ? 'AB' : 'AA'}`)).status === 401);
  const oldPayload = Buffer.from(JSON.stringify({ v: 1, p: String(own.permissionId), exp: Math.floor(Date.now() / 1000) - 60 })).toString('base64url');
  const oldMac = createHmac('sha256', process.env.SESSION_SECRET).update(`receipt:${oldPayload}`).digest('base64url');
  check('a correctly signed receipt that has expired is refused', (await progress(`receipt=${oldPayload}.${oldMac}`)).status === 401);
  check('with no receipt, nothing is returned', (await progress('permission=1')).status === 401);
} catch (e) {
  check(`the check crashed: ${e?.stack ?? e}`, false);
} finally {
  // The open fixtures are withdrawn; the closed ones stay, so each state's page can be looked at.
  await query(`UPDATE billing_links SET revoked_at = now() WHERE token = ANY($1) AND revoked_at IS NULL AND NOT single_use`, [[tokens.ok, tokens.other, tokens.signup].filter(Boolean)]).catch(() => {});
  if (pass + fail < EXPECTED) check(`ran to completion (${pass + fail} of ${EXPECTED})`, false);
  console.log(`\nfixture pages: /pay/${tokens.missing} /pay/${tokens.expired} /pay/${tokens.revoked} /pay/${tokens.single}`);
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await close(); process.exit(fail ? 1 : 0);
}
