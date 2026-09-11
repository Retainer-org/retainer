# Handover — where Retainer stands

Written 2026-09-11, at commit `0f38ab5` (Base Sepolia block 46666326). Phase 3 is
closed. Nothing further is being built until there are merchant conversations to
build for. Every transaction below was re-read from the chain when this was
written, and `npm run check:txs` re-verifies all of them on every run.

## Where Phase 3 landed

A customer with an ordinary browser wallet can now do the whole flow on testnet:
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
in the README and on the landing page, and is unchanged.

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

To re-establish all of this from scratch: `npm run check`, `npm run drill:metamask`,
`npm run check:sign-ui` (needs Chrome and the dev server), and
`npm run session:report -- --signer 0x…` for any customer's full hash table.

## The remaining gaps

1. **No hosted worker.** Charging, confirmation, indexing, overdue detection and
   alerts all run only where `npm run worker` runs — today, a developer machine.
   The website never does any of them. Nothing is charged while the worker is off.
2. **The executor key is not on Vercel**, deliberately, so the public site cannot
   register a permission. Registration is the only thing on the site that needs
   the key. The key and the worker should go live together: a public flow where a
   stranger can sign but is never charged looks broken rather than absent. Before
   they do, the registration rate limits (per signer, per client, global) are
   already built.
3. **Deep reorgs are detected, not handled.** Incoming transfers are indexed at
   three confirmations and store their block hash, so a reorg beneath one can be
   noticed. Nothing unwinds a match whose transfer disappears; a person would.
4. **No authentication on the dashboard.** It is public. The review queue's five
   actions are the only writes, and they are switched off unless
   `RETAINER_ENABLE_REVIEW_WRITES=true`, which the public deployment does not set.
5. **2 test USDC stranded** in `0x291E71F715Cb73CEcfF3cB5a0C0286892297D121`, a
   smart account from the first Phase 3 drill run, whose throwaway key was not
   saved (keys are now logged to `/tmp`). Its permission was registered in
   `0xf9eb64186a55a169631994c96daec5c3b19290f872922af4636e7915da5213dd` and never
   revoked, so it could in principle be recovered to the treasury by decoding that
   permission from the registration's calldata and charging it. Not attempted;
   it is 2 test USDC.

Also open, all listed on `/docs/limitations`: production reads are not pinned to a
block (a lagging public RPC node can answer stale); registration rate limits key on
an unsalted IP hash; the indexer stores other parties' events from the shared
manager; a wallet-owned account starts empty, so the customer must fund it (a
gasless top-up by EIP-3009 is simulated, not built); mainnet is untested, and the
one-signature path depends on Solady's ERC-6492 verifier existing there. What
MetaMask displays at signing, including any warning, has not been written up in
this repository.

One deliberate exception to know about before changing the signing code: exactly
one EIP-7702 delegate is accepted as an owner — MetaMask's
`EIP7702StatelessDeleGator`, pinned to the hash of its reviewed code. The reasoning
is beside it in `packages/chain/src/smart-account.js`. Every other delegate is
refused.

## What is live, and what is not

Production (`retainer-one.vercel.app`) is deployment `retainer-5jzr3oz4f`, built
on 2026-09-09 from the tree committed as `169266d`. Five commits since are not
deployed: the Phase 2 docs and architecture diagram, the whole wallet-owned
signing flow and its consent screen, the account and network handling from the
live sessions, the 7702 exception, and the corrected site nav.

Deploying those five commits needs no new environment variables. On the public
site, without the executor key, the new sign page would show the terms and check a
visitor's account, then say plainly that signing is not switched on for this
deployment. It would not register anything. The database is shared, so the live
dashboard already shows every permission and charge above; it is only the pages
that are behind.

## Pointers

- `README.md` — phase-by-phase status and the evidence tables.
- `/docs` — every claim cited to a file and line; `/docs/limitations` is the
  honest list; `/docs/wallets` is Phase 3.
- `scripts/` — the drills, the checks, `prune-drill-data.mjs` for residue, and
  `session-report.mjs`.
