# Vendored source provenance

These files are copied **verbatim** from
[`coinbase/spend-permissions`](https://github.com/coinbase/spend-permissions)
at commit `e0004e63edc4e17de7aa978293800ac7a16892e5`
("Enable build_info in deploy profile for contract verification (#83)", 2026-03-24).

**Do not modify them.** Retainer deploys its own instance of the audited
`SpendRouter`; it does not fork or alter the logic. Any change here voids the
audits below and must be reviewed as new contract work.

## Files

| File | sha256 |
|---|---|
| `SpendPermissionManager.sol` | `2a5a0d72f06cd1b66099d4e8ee9129dc5c52c75c46a4b42eeebf415b4fb2a231` |
| `SpendRouter.sol` | `104e1a47fb47e3ebc92710721ac37a3b7c999081c1257b34608ab3aaf8d636f2` |
| `PublicERC6492Validator.sol` | `f3cb49c5864badf20ccc7dfaccb0c98aa28c2a01520bf923d2087394f00433ca` |

Re-verify at any time with `script/verify-vendor.sh`.

## Audits (upstream)

| Scope | Date | Report |
|---|---|---|
| SpendPermissionManager | Oct 2024, Nov 2024, Dec 2024 | Cantina |
| SpendRouter | 2026-03-18, 2026-03-21 | Cantina (`audits/Cantina-March-2026-SpendRouter*.pdf`) |

## What we deploy

Only `SpendRouter`. `SpendPermissionManager` and `PublicERC6492Validator` are
vendored for compilation and testing against the **already-deployed** canonical
instances, which we do not redeploy:

| Contract | Address (same on Base + Base Sepolia) |
|---|---|
| `SpendPermissionManager` | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` |
| `PublicERC6492Validator` | `0xcfCE48B757601F3f351CB6f434CB0517aEEE293D` |

Verified 2026-09-08: the deployed manager's on-chain `SPEND_PERMISSION_TYPEHASH`
equals `keccak256` of the type string in this vendored source
(`0xc9fa0f0252014cf89ab0539e3bb3adcb76f93e6bb6494e8cc61c14e2761ee2e4`), so the
vendored code matches the bytecode we transact against.
