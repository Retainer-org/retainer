# Retainer

Recurring and usage-based USDC billing on Base, built on Base Account spend
permissions. Retainer is the billing layer above the primitive: scheduling,
retries, failure classification, and reconciliation.

**Phase 1 — the charge engine. Base Sepolia only.**

---

## ⚠️ Keys in this repo are disposable testnet keys

The executor, merchant treasury and test user keys generated for this phase are
**Base Sepolia only** and are to be treated as permanently compromised.

- **They must never be reused on mainnet under any circumstances.**
- If Retainer goes to mainnet, we generate an **entirely new set** of keys.
- Private keys live only in `.env` (gitignored, mode `0600`) and Railway
  environment variables. They are never committed, logged, or printed.

---

## Custody model — the invariant everything else rests on

Funds move **customer → SpendRouter → merchant treasury in one atomic
transaction**. Retainer holds the executor key, which can *trigger* a charge,
and never holds funds.

There is deliberately **no code path where money rests in a Retainer-controlled
wallet** — not for fees, not for refunds, not for failed forwards. If the
forward fails the whole transaction reverts, so nothing is ever left in the
router.

`test/retainer/RouterCustodyInvariant.t.sol` asserts this and **fails the build**
if the router ever holds a balance after a charge.

A structural consequence: `SpendRouter.extraData` encodes exactly one recipient
and forwards the full value, so there is no fee split. Retainer's revenue is a
flat SaaS fee to merchants, never a percentage of flow.

## Phase 1 status — closed 2026-09-09; consent step closed 2026-09-10

Everything in the Phase 1 definition of done is proven on Base Sepolia. The one
step that stayed open — a real wallet consenting in a browser — was blocked for
Base Accounts by a Coinbase bug. It is now proven by a different route: a
MetaMask account owning a smart account, signing through the sign page. See
[A browser wallet can sign on testnet](#a-browser-wallet-can-sign-on-testnet).
The Coinbase constraint itself is unchanged, and stays documented below.

### Proven

| | Evidence |
|---|---|
| Router deployed and verified | [`0x337099eE…`](https://sepolia.basescan.org/address/0x337099eE403C090388A66cc9370F7b0Fe4CDcC79#code) |
| Custody invariant on live chain | router and executor USDC balances both zero after every charge |
| All six failure modes | classified from chain state, no gas burned on any |
| Crash recovery, both branches | receipt-found and nonce-superseded; exactly one spend each |
| Variable amount computed at charge time | charge 9: enqueued at 0, settled 1,250,000 |
| Confirmation discipline | reconciler sole writer of `confirmed`, both event topics required |

Six confirmed charges, each mapping to one transaction hash:

```
1  fixed 1000000  0x91a4980a793c29276f55871b4f2a372d2c4f3170ec06f61dfd20d3a6948a1e7c
8  fixed 1500000  0x35043fd149c096816da7f64a2270dba1ae758c021945f11dcf357bf6ba8aaa93
9  usage 1250000  0x55c0e2b51f9580bf05e272a3e9e5b5d90d4ec8f0f9b308192126b7117b9bea3d
10 fixed 1100000  0x8e4ce873249fc57b52485086de99aa4a0b9e341a7165916282153bbf9f68e2df
11 fixed 1300000  0xe0ac2a1eed2bb2a5ea4c0a6ee418d4edb37c2320f488fa6b5eb2026aabb5244d
12 fixed  900000  0xa90432814929063ed876f09f540ea2eea8e44188602f73c8095589cf1a545103
```

### Crash recovery — both branches, on-chain

Worker killed **after** `eth_sendRawTransaction` returned and **before** the row
was updated (charge 10, nonce 22). On restart, recovery found the receipt and
confirmed it. Exactly one spend:

```
found-onchain   0x8e4ce873249fc57b52485086de99aa4a0b9e341a7165916282153bbf9f68e2df
```

Worker killed after persisting the signed attempt and **before** broadcasting
(charge 11, nonce 24). A competing transaction then consumed nonce 24. On
restart, recovery marked the attempt superseded — it never re-broadcast — and
the charge succeeded on a fresh nonce. Exactly one spend:

```
superseded attempt (never landed)  0x0a078798bcc3d5c5947a4c21687fed79a79332c1521b4b4900d62bfd2e9131a3
competing tx that took nonce 24    0x21cd8eb371c6557815715a4b69140c183f5b3981237d76c7724269f01622c32d
final charge, nonce 25             0xe0ac2a1eed2bb2a5ea4c0a6ee418d4edb37c2320f488fa6b5eb2026aabb5244d
```

Sum of the six settled amounts is 7,050,000 (7.05 USDC); the merchant treasury
held exactly 7,050,000 and the router 0 when checked on 2026-09-09.

### A browser wallet can sign on testnet

On 2026-09-10 a MetaMask account signed a spend permission on Base Sepolia
through `/sign`, end to end — no Base Account, and no Coinbase consent screen.
**This is the working route on testnet.**

| Step | Evidence |
|---|---|
| One signature: smart account created, manager an owner, permission #18 approved — one executor transaction | [`0xa647cbb0…bf34b`](https://sepolia.basescan.org/tx/0xa647cbb0f762f9ea7d4fe7eaef576021f4564840f5d4c0b9cd27e6dc142bf34b) |
| The fingerprint on the page matched the hash MetaMask displayed | observed by the operator during the session |
| The customer funded their smart account, 20 USDC | [`0xd7b54e9e…8a4d6`](https://sepolia.basescan.org/tx/0xd7b54e9e251f1da863731753678c4c368af928e5e3ff1354ae24391600c8a4d6) |
| First charge: 1.000000 USDC to the treasury, confirmed by the reconciler | [`0x36b5468c…8dfba`](https://sepolia.basescan.org/tx/0x36b5468cc65fb1a307ff75d5039f6a01d1b40760e1c53264635c7818a3e8dfba) |
| The customer revoked #18 from the page, with the same wallet | [`0x2b19810b…b7a55`](https://sepolia.basescan.org/tx/0x2b19810bc90818b1a1baf0f6690aed03b1c3138cc0e218961b6f9d2b409b7a55) |
| The next charge against #18 was refused by the pre-flight: `REVOKED`, terminal, no transaction signed or sent | none, by design — executor nonce and balance unchanged |

Sign, charge and revoke are all proven with a browser wallet. One thing the session
surfaced that no drill could: **MetaMask upgraded the account to EIP-7702 inside the
revoke**, relaying it through its own `DelegationManager`. Existing permissions keep
working, but a new registration from an upgraded account is refused until MetaMask's
delegator is accepted — it has been tested and validates the signature, and whether to
accept it is an open decision. See `/docs/wallets#metamask-upgrades`.

The mechanism — an EOA-owned `CoinbaseSmartWallet`, a typed-data signature, and
ERC-6492 deployment inside `approveWithSignature` — is described at `/docs/wallets`
and exercised with every negative control by `npm run drill:metamask`.

### Base Account consent — still blocked upstream

**A real Base Account cannot consent to a spend permission on Base Sepolia.**
Coinbase's hosted signing UI at `keys.coinbase.com` rejects the request with:

> This chain is not supported. Base Sepolia is not supported. Please try a different chain.

Tracked as **[base/account-sdk#363](https://github.com/base/account-sdk/issues/363)**
(open since 2026-07-10, no maintainer response as of 2026-09-09). A
documentation-only PR describing it,
[#390](https://github.com/base/account-sdk/pull/390), has also been open and
unmerged since 2026-08-21.

**The message is misleading — it is not a chain-support decision.** Base Sepolia
is present in the popup's supported-chains map; its `displayName` is what fills
the error text. The operative term is `isTestnet`, inside the wallet-upgrade
path. The refusal is testnet **delegation provisioning**, surfaced with
chain-support copy.

**What actually determines success is account type:**

| Account type | On-chain code | Base Sepolia consent |
|---|---|---|
| ERC-4337 (factory-deployed contract) | starts `0x363d3d37`, 61 bytes | works |
| EIP-7702 (delegated EOA) | starts `0xef0100`, 23 bytes | refused |

Newly created Base Accounts are now EIP-7702 provisioned, which is the broken
path. Accounts created before that change reportedly still work. The scripted
test wallet in `scripts/setup-test-account.js` is ERC-4337, which is exactly why
every drill in this repo passes.

This also blocks Coinbase's own documented `pay({ testnet: true })` flow, and
`wallet_getCapabilities` still reports Base Sepolia as capable for the same
account it refuses — so there is no capability-based way to detect it before the
user reaches the popup.

**Deliberately not worked around.** Going to mainnet to dodge it would mean a
permanent deployment and a real-money key set months ahead of need, to route
around someone else's open bug. The gap is recorded rather than papered over.

## Reproducing the test setup — the non-obvious prerequisite

**The `SpendPermissionManager` must be an owner of the smart account, or every
charge reverts.**

`SpendPermissionManager` moves funds by calling `execute()` on the user's
account, and `CoinbaseSmartWallet.execute` is `onlyEntryPointOrOwner`. So unless
the manager (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`) is registered as an
owner, `spend()` fails — and it presents as a mysterious universal revert with
nothing in the permission itself looking wrong.

Coinbase's own wallet does this inside its permission-approval flow, so it is
invisible on the real browser path. A **scripted** wallet has to do it
explicitly:

```js
// after createAccount(), as an existing owner
await wallet.writeContract({
  address: smartAccount, abi: walletAbi,
  functionName: 'addOwnerAddress',
  args: [SPEND_PERMISSION_MANAGER],
});
```

`scripts/setup-test-account.js` does this, and upstream's own Foundry test base
does the same thing (`account.addOwnerAddress(address(permissionManager))`).

A second consequence: a spend permission's `account` must be a Base Account, so
a plain EOA can never be the payer. It can only be an *owner* of one.

## Layout

```
contracts/          Foundry. Vendored audited source + our deploy script and tests.
  src/              coinbase/spend-permissions @ e0004e6, VERBATIM — see src/PROVENANCE.md
  script/           DeployRouter.s.sol, install-deps.sh, verify-vendor.sh
  test/retainer/    Custody invariant + error-selector guard
```

## Setup

```bash
cp .env.example .env               # fill in; never commit
contracts/script/install-deps.sh   # pinned dependency revs
cd contracts && forge build && forge test

npm install
node --env-file=.env packages/db/src/migrate.js
```

## Running

The worker and CLI read `.env` directly. Next does not, so export it first:

```bash
# charge engine
node --env-file=.env apps/worker/src/index.js            # loop
node --env-file=.env apps/worker/src/index.js --once --charge <id>
node --env-file=.env apps/cli/src/index.js status|ledger|attempts|audit|gas

# web: landing page at /, signing harness at /sign -- port 3017
set -a; . ./.env; set +a
npm run dev -w @retainer/web
```

### Landing page and Aceternity UI

`apps/web` is adapted from the Aceternity UI Pro **Simplistic SaaS** template
(Next 16, Tailwind 4, `next-themes`, `motion`). The raw template zips live
**outside** this repo and are never committed; only adapted code in our own files
is. Social-proof, testimonial and pricing sections were removed rather than
filled -- nothing here can back them.

Paid Aceternity components resolve through the shadcn registry with an auth
header. `apps/web/components.json` references the key as `${ACETERNITY_UI_API_KEY}`
and shadcn expands it from `.env` at run time, so the literal key never enters
git. To use the registry or the MCP server, export `.env` first:

```bash
set -a; . ./.env; set +a
npx shadcn@latest add @aceternity/<component>   # from apps/web
```

`.mcp.json` registers the shadcn MCP server for Claude Code and contains no
secrets. Never paste the key into `components.json` directly.

The signing page must import the SDK's **browser** entrypoints
(`@base-org/account/browser`, `@base-org/account/spend-permission/browser`).
The default export condition resolves to the Node build, which pulls in
`@coinbase/cdp-sdk` and its optional `@x402/*` peers and fails to compile.

`contracts/lib/` is gitignored — dependencies are reinstalled from the exact
revisions pinned in `install-deps.sh`, which match upstream's `foundry.lock`.

### Checking the claims against reality

Every claim in `/docs` cites a file and line, a contract, or a transaction, and
the dashboard states what each page reads. All of that drifts silently when the
code moves, so all of it is checkable:

```bash
npm run check                # everything below
npm run check:docs           # every citation resolves to a real file and line
npm run check:docs -- --all  # print each citation with its cited source line
npm run check:txs            # every cited hash still resolves on Base Sepolia
npm run check:sources        # each dashboard page's declared source is its real one
npm run check:degradation    # a dead RPC degrades; it never guesses
```

`check:docs` is filesystem-only — no server, database or network — so it runs in
CI. The other three need `.env`: `check:txs` asks the chain, and asserts the
opposite claim too (the crash-B attempt cited as *never mined* must still not
resolve, and the vendored EIP-712 typehash must still equal the deployed
manager's). `check:sources` fails if a page claims "database only" while calling
the chain-reading loader. `check:degradation` points the RPC at a dead port and
asserts the dashboard still renders from the database, reporting `unknown`
rather than inferring a value from a missing reading — then re-runs against the
live RPC as its own negative control.

### Drills

```bash
npm run drill:matching   # all six matching cases, against real transfers
npm run drill:alerts     # overdue detection, webhook signing and retry, email transport
npm run drill:dashboard  # the five review actions, over real HTTP
npm run drill:metamask   # a wallet-owned smart account end to end: controls, register, charge, 7702, revoke
npm run session:report -- --signer 0x...   # every hash for one customer's session, from the chain and our records
npm run prune:drills     # report leftover drill rows (add -- --apply to remove)
```

Every assertion has a negative control that has been confirmed to actually fail;
a check that passes because it never ran is worse than no check. Each drill
sweeps before it starts and again when it finishes, so a drill run leaves no
rows behind — residue on the dashboard is indistinguishable from a merchant's
own data, and eventually gets mistaken for it. `prune:drills` performs the same
sweep inside one transaction that re-reads every publicly cited row field by
field and rolls back unless they are byte-identical.

## Vendored contracts

We deploy **our own instance of the audited `SpendRouter`**, unmodified. We do
not fork it. `contracts/script/verify-vendor.sh` re-checks the vendored source
against upstream by sha256 and fails if anything drifted.

`SpendPermissionManager` is **not** redeployed — the canonical instance at
`0xf85210B21cC50302F477BA56686d2019dC9b67Ad` is already live on Base and Base
Sepolia. Its on-chain EIP-712 typehash matches our vendored source, so the code
we read is the code we transact against.

## Chain addresses (Base Sepolia, chainId 84532)

| What | Address |
|---|---|
| SpendPermissionManager | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` |
| PublicERC6492Validator | `0xcfCE48B757601F3f351CB6f434CB0517aEEE293D` |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Retainer SpendRouter | [`0x337099eE403C090388A66cc9370F7b0Fe4CDcC79`](https://sepolia.basescan.org/address/0x337099eE403C090388A66cc9370F7b0Fe4CDcC79#code) (verified) |

## Out of scope in Phase 1

No landing page, docs site, design work, or component library. No invoices, tax,
proration, refunds, plans, or customers-as-objects. No mainnet. No usage
forecasting or re-authorization.
