# Handover — where Retainer stands

Updated 2026-09-11, after the testnet deployment went live. Every transaction
below was re-read from the chain when this was written, and `npm run check:txs`
re-verifies all of them on every run.

## Where Phase 3 landed

A customer with an ordinary browser wallet can do the whole flow on testnet:
sign a spend permission, be charged, revoke it, and register again — including
after MetaMask has silently upgraded their account to EIP-7702. No Base Account
and no Coinbase consent screen is involved, so base/account-sdk#363 no longer
blocks anything on testnet; it still blocks the Base Account path, and is
documented as such.

How it works, in one line: the customer's wallet owns a `CoinbaseSmartWallet`
created for it, signs `CoinbaseSmartWalletMessage{hash}` typed data, and a single
`approveWithSignature` (ERC-6492) creates the account, makes the manager an owner
and approves the permission, gas paid by our executor. Details: `/docs/wallets`.

## What is proven, with transactions

The Phase 1 evidence — six confirmed charges and both crash-recovery branches — is
in the README and on the landing page, and is unchanged. The live worker is
barred from touching it (see `RETAINER_CLAIM_ABOVE_CHARGE_ID` below).

Phase 3, all with a real MetaMask wallet in live sessions:

| What | Transaction |
|---|---|
| Permission #18: one signature, smart account created, permission approved | `0xa647cbb0f762f9ea7d4fe7eaef576021f4564840f5d4c0b9cd27e6dc142bf34b` |
| Charge #16: 1.000000 USDC to the treasury, confirmed by the reconciler | `0x36b5468cc65fb1a307ff75d5039f6a01d1b40760e1c53264635c7818a3e8dfba` |
| Customer revoked #18 from the page (MetaMask upgraded the account to 7702 inside it) | `0x2b19810bc90818b1a1baf0f6690aed03b1c3138cc0e218961b6f9d2b409b7a55` |
| Customer revoked #20 (the same upgrade, on the second account) | `0x48c02895cd37c435c38cd73219b7ba892c53ed5d9504fb978abcb0e151075d20` |
| Customer revoked #19 | `0xc1c01f5be4963179a30f48d732a8aa5c22f87076a5eb1f53087c1d3f7f93ac8d` |
| Re-registration by a MetaMask-upgraded (7702) account: #23 | `0x369cf3b5fb0b6dd6089f94b3615458cc12a7e53b210a85db8b5d2b785e2bfbed` |
| Re-registration by the other upgraded account: #24 | `0xaebe8226847ce0b5779a239b3bc1b72bee2ddee0fece10dbdf2b00c8cb4a4172` |
| Owner withdrew 20 USDC from their smart account, from the page | `0x08162a515b3bea0090c179be05b49aa92543054cc124cc5ce2274387129d50be` |

The next charge against revoked #18 was refused by the charger's pre-flight —
`REVOKED`, terminal — with no transaction signed or sent: the executor's nonce and
balance were unchanged to the wei. There is no hash for it because none exists.

Proven by drill rather than by a person, and re-run by `npm run drill:metamask`
(47 checks, each refusal asserted as "right reason, no transaction, no row"):
every signature, policy, rate-limit, owner-code and revoke control; the
7702 exception's two negative controls; and a real registration by an account
delegated to MetaMask's delegator, first done in
`0xbb7dd1d27ebcc5ab8c72670f359609e6d45ba438be5516058bd6e0cc3ff6eb07`. The
delegator itself was tested before it was trusted in
`0x930de800f78638f8f2457e5b5b0d182f44fb73807da704d56f83f39a97fdebe2`.

### On the public deployment, 2026-09-11

`scripts/public-loop.mjs` against `https://retainer-one.vercel.app`, driving the
real `/sign` page in headless Chrome with a scripted wallet (not MetaMask — it
proves the deployment, not what MetaMask displays). Customer
`0x69EBE8D365EB23421eb949564DA9e4519FaE8680`, a throwaway key. All 18 checks
passed (the run also printed a failed completion check, because the script expected
19 assertions and has 18 — a miscount since corrected, not a skipped step):

| What | Transaction |
|---|---|
| Customer funded their smart account from the page | `0x575d7f23c9f9f4831d569383654ebedfc91134c96cc47459616409ba5134b9cd` |
| Permission #26 registered by the production executor (account created in the same transaction) | `0x94d36955a7bc179689920c62162723e0956f38e828fdce92728bfc865244b6ae` |
| Charge #20, 1.000000 USDC to the treasury, sent by the Railway worker — which crashed on purpose right after broadcasting it (see below) | `0xec8ae24f40574c1ce179d4b142293cea3bf976cb543b5a03e1449baee391b67b` |
| Customer revoked #26 from the page; recorded only after the server verified receipt, event and `isRevoked` | `0xa13928fb1bb287d9e462192246df92631fdb63c1dde5902af90d6cc004946bc6` |

In the same run, a second, validly signed registration by the same customer was
refused `429 rate_limited` with the executor's nonce unchanged (54 → 54) and no
row written. Separately, four tampered-terms registrations (allowance, period,
spender, end) were each refused `400 policy` on production, nonce unchanged.

The run before it (permission #25, charge #19 in
`0xa430f0606a70b8a709cebda3632042f99c789e500f7403414fba00fdb910f02d`) found a real
defect: the customer's revoke `0x0897563f9ef23725bff797f677527c0c40ee57cfb68513cad51b5cc2bc003f09`
succeeded on-chain, but the server's check read the chain from a public RPC node a
block behind and refused to record it — and the page marked it revoked without
looking at the server's answer. Both are fixed (commit `6f171c6`): early reads are
retried, `isRevoked` is read at the revoking block, and the page says plainly when
a revoke is on-chain but not yet recorded. #25's revoke was then submitted again
and recorded after verification.

**Crash test on Railway.** With `RETAINER_CRASH_AFTER_BROADCAST=1` on the live
service, the worker claimed charge #20 at 10:00:09 UTC, broadcast it, and exited
137. Railway restarted it within the same deployment (`worker.start` again at
10:00:12, resuming from the stored cursors); recovery found attempt #13 on-chain
(`found-onchain`) and did not re-send; the reconciler confirmed it at 10:00:26.
Exactly one attempt row, exactly one outgoing USDC transfer from the customer's
smart account, and its balance is 2 − 1 = 1 USDC. Crash injection was then
removed and the service redeployed; the running worker logs `crashInjection=false`.

To re-establish all of this from scratch: `npm run check`, `npm run drill:metamask`,
`npm run check:sign-ui` (needs Chrome and the dev server), and against any
deployment `scripts/public-loop.mjs`, `scripts/check-stranger.mjs` (every route,
both themes, phone width, fresh profile: 94/94 on production) and
`scripts/check-gas-warning.mjs`. `npm run session:report -- --signer 0x…` prints
any customer's full hash table.

## What is live, and where every setting lives

**Web** — Vercel project `retainer`, production alias `retainer-one.vercel.app`,
deployment `dpl_LVNaxg2sBi2cS1FmDUAzvK2QFtAc`, built from commit `6f171c6`.
`EXECUTOR_PRIVATE_KEY` is set (Sensitive) so the public site can register;
`RETAINER_ENABLE_REVIEW_WRITES` is not set, so the dashboard is read-only — a
direct POST to the review action on production is refused with "Review actions
are disabled", while the same POST against a server with writes enabled reaches
the database. The key was searched for, with and without `0x`, in 17 production
routes and every JS chunk they load: not present; no source maps are served.

**Worker** — Railway project `retainer` (workspace "Jagadeesh B's Projects"),
environment `production`, service `retainer-worker`, deployed from this machine
with `railway up`; no GitHub connection, no Railway database (it uses the same
Neon database as the site). The image is `apps/worker/Dockerfile`: the worker and
the two packages it needs, nothing else, running as `node`.

| Setting | Value | Where it lives |
|---|---|---|
| Dockerfile | `apps/worker/Dockerfile` | service variable `RAILWAY_DOCKERFILE_PATH` |
| Restart policy | `ON_FAILURE`, 10 retries | Railway's service defaults (recorded on each deployment; not set by us) |
| Replicas | 1, region `europe-west4-drams3a` | Railway's service defaults (`multiRegionConfig`) |
| Deploy overlap | Railway's default (`overlapSeconds` unset) | not set — see the overlap note below |
| Claim floor | `RETAINER_CLAIM_ABOVE_CHARGE_ID=12` | service variable |
| Alerts | `ALERT_EMAIL_TRANSPORT=console` (appear in Railway's logs) | service variable |
| Chain, database, executor | `CHAIN_ID`, `BASE_SEPOLIA_RPC_URL`, `SPEND_PERMISSION_MANAGER`, `SPEND_ROUTER`, `USDC_ADDRESS`, `EXECUTOR_ADDRESS`, `EXECUTOR_PRIVATE_KEY`, `MERCHANT_TREASURY_ADDRESS`, `DATABASE_URL` | service variables |

**Why `railway.json` is not what configures the service.** It is in the repo with
the intended settings (Dockerfile builder, one replica, restart on failure, no
overlap), but Railway did not read it: the first two deployments were built with
its automatic builder (Railpack) and failed for want of a start command, and the
second one's record shows `fileServiceManifest: {}` — no config file consumed. The
first explanation tried, that `.dockerignore` (an allow-list) hid the file, was
wrong: allowing it through changed nothing. The actual cause was not determined.
What works is the `RAILWAY_DOCKERFILE_PATH` variable, which is documented; the
restart and replica values it needs were already Railway's defaults, and
`railway environment edit` reported "No changes to apply" when asked to set them.
**`railway.json` / config-as-code is deprecated by Railway and stops working on
2026-12-01**; the CLI's replacement is `.railway/railway.ts` (`railway config
migrate`). A migration is required before then, and should be checked the same way
as above: read back each deployment's `serviceManifest` and confirm the builder.

It was tried on 2026-09-11, after the deployment was verified, as a dry run only
(`railway config migrate`, which writes nothing). Its output cannot be applied as it
stands: it names the service `retainer` instead of `retainer-worker`, so applying it
would target a service that does not exist; it leaves the Dockerfile path and builder
as comments rather than settings; and it drops the restart, overlap and draining
settings. Nothing was written or applied. Whoever migrates should start from
`railway config pull` (which imports the live service's actual configuration), add
the Dockerfile path, and check `railway config plan` shows no change to the running
service before `railway config apply`.

**The claim floor.** `RETAINER_CLAIM_ABOVE_CHARGE_ID=12` means charges #1–#12 —
the Phase 1 evidence cited on the landing page and in the README, several left
deliberately failed — are never claimed, by the scheduler or by `--charge`. It was
proven both ways before the worker first ran: unset, the worker would claim #3,
#2, #4, #7; at 12, nothing. Their rows are unchanged since.

**Resumption.** The worker logs the stored cursors it starts from on every start
(`worker.cursors`); every deployment and restart so far resumed from them, never
from a fresh start.

## The remaining gaps

1. **Nothing schedules a charge for a new public permission.** A stranger can
   sign and register on the public site, and revoke, but a charge exists only when
   an operator creates one (`npm run cli -- enqueue --permission <id>`); the only
   other caller is the public-loop script. The hosted worker then charges it. So
   the public demo shows consent and revocation for real, and a charge only when
   someone schedules one. Automatic scheduling on registration is a product
   decision that has not been made.
2. **A deploy briefly runs two workers.** On a redeploy Railway starts the new
   deployment before stopping the old one: observed overlap about 3.7 s. Claims
   use `SKIP LOCKED` and nonces are allocated under a lock, but recovery picks up
   *every* open attempt, including one the old worker is still broadcasting. Its
   re-send is harmless (same nonce, same hash); its `superseded` branch is not if
   a lagging RPC shows the nonce spent before the receipt — the charge would be
   retried though the first may have landed (capped by the allowance). Until this
   is fixed (a single-instance lock, or recovery that ignores attempts younger
   than a few seconds), redeploy only when no attempt is open — every redeploy
   above was checked for that first. The same gap exists after a plain crash.
3. **The worker is an ocean away from its database.** Neon is in AWS
   `us-east-2`; the Railway service defaulted to `europe-west4`. Measured from the
   running service at startup: 99.9–107 ms per `SELECT 1` (median), ~108 ms per
   RPC call. An idle tick makes on the order of twenty database round trips (an
   estimate from the code, not a measurement), so roughly two seconds of each
   4-second poll is spent waiting on the network. A US-East Railway region
   (e.g. `us-east4`) would be expected to cut each round trip to a few
   milliseconds; not changed, because it moves the service.
4. **Deep reorgs are detected, not handled.** Incoming transfers are indexed at
   three confirmations and store their block hash, so a reorg beneath one can be
   noticed. Nothing unwinds a match whose transfer disappears; a person would.
5. **No authentication on the dashboard.** It is public and read-only: the review
   queue's five actions are the only writes, and they are switched off unless
   `RETAINER_ENABLE_REVIEW_WRITES=true`, which the public deployment does not set.
6. **Gas.** The executor holds about 0.0897 ETH: roughly 124,000 registrations or
   71,000 charges at #24's measured cost (98,336 gas plus a 31,477,998,711 wei L1
   fee per registration). The dashboard header warns and registration closes below
   1,000 registrations or 100 charges; the worker stops starting charges below 5.
   Shown in a real browser at both levels, from genuinely low balances, with the
   real executor as the negative control.
7. **Test funds left behind:** 2 test USDC in
   `0x291E71F715Cb73CEcfF3cB5a0C0286892297D121` (first Phase 3 drill, key not
   saved); 1 test USDC in each public-loop customer's smart account (keys kept
   outside the repo).

Also open, all listed on `/docs/limitations`: production reads are not pinned to a
block (a lagging public RPC node can answer stale — the revoke defect above was one
case); registration rate limits key on an unsalted IP hash; the indexer stores
other parties' events from the shared manager; a wallet-owned account starts
empty, so the customer must fund it; mainnet is untested, and the one-signature
path depends on Solady's ERC-6492 verifier existing there. What MetaMask displays
at signing, including any warning, has not been written up in this repository.

One deliberate exception to know about before changing the signing code: exactly
one EIP-7702 delegate is accepted as an owner — MetaMask's
`EIP7702StatelessDeleGator`, pinned to the hash of its reviewed code. The reasoning
is beside it in `packages/chain/src/smart-account.js`. Every other delegate is
refused.

## Pointers

- `README.md` — phase-by-phase status and the evidence tables.
- `/docs` — every claim cited to a file and line; `/docs/limitations` is the
  honest list; `/docs/wallets` is Phase 3.
- `scripts/` — the drills, the checks, the public checks, `prune-drill-data.mjs`
  for residue, and `session-report.mjs`.
