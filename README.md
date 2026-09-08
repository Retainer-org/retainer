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

## Phase 1 status — closed 2026-09-09

Everything in the Phase 1 definition of done is proven on Base Sepolia **except
the real-account browser consent step, which is blocked upstream by a Coinbase
bug**. That gap is not in this repository and there is no change we can make
here that closes it.

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

### Not proven — blocked upstream

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

# signing page (test harness) -- port 3017
set -a; . ./.env; set +a
npm run dev -w @retainer/web
```

The signing page must import the SDK's **browser** entrypoints
(`@base-org/account/browser`, `@base-org/account/spend-permission/browser`).
The default export condition resolves to the Node build, which pulls in
`@coinbase/cdp-sdk` and its optional `@x402/*` peers and fails to compile.

`contracts/lib/` is gitignored — dependencies are reinstalled from the exact
revisions pinned in `install-deps.sh`, which match upstream's `foundry.lock`.

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
