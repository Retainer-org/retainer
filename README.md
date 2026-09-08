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
cp .env.example .env          # fill in; never commit
contracts/script/install-deps.sh   # pinned dependency revs
cd contracts && forge build && forge test
```

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
