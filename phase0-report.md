# Stipend — Phase 0 Investigation Report

**Date:** 2026-09-08
**Scope:** Desk research only. No code written, no repo scaffolded.
**Target:** Base Batches 005 (expected ~Feb 2027)
**Recommendation:** **Qualified go** — but not for the product as hypothesised. See §7.

---

## Note on evidence quality

I have graded every claim below:

- **[P] Primary** — read directly from source code, official docs, or the vendor's own reference. Trust these.
- **[S] Secondary** — press, analyst posts, third-party summaries. Directionally useful.
- **[V] Vendor-marketing** — comparison tables published by *competitors in the same category* (notably `eco.com`, `spark.money`, `qbitflow.app`, `boomfi.xyz`). These are SEO content marketing by interested parties. I have used them only to generate leads, and I flag every claim that rests on them alone.
- **[U] Undetermined** — I could not establish this. Listed together in §8 so you can see the shape of what's missing.

A large amount of the competitor-landscape material on the open web for this exact category is [V]. That is itself a signal: the space is crowded enough that vendors are fighting over comparison keywords.

---

## Q1 — What can spend permissions actually express?

**One-line answer: They express a revocable, non-custodial, offline-executable pull of a *variable* amount up to a fixed cap per fixed-length period — which is more than enough for both fixed subscriptions and metered billing, with one hard limit: you cannot exceed the cap, and you cannot raise the cap without a fresh user signature.**

### The struct

From `SpendPermissionManager.sol` [P]:

```solidity
struct SpendPermission {
    address account;    // smart account the permission is valid for
    address spender;    // entity that can spend account's tokens
    address token;      // ERC-7528 native token or ERC-20 contract
    uint160 allowance;  // Maximum allowed value to spend within each `period`
    uint48  period;     // seconds; resets used allowance on a recurring basis
    uint48  start;      // inclusive, unix seconds
    uint48  end;        // exclusive, unix seconds
    uint256 salt;       // differentiates otherwise-identical permissions
    bytes   extraData;  // arbitrary data consumed by the spender
}
```

Source: [SpendPermissionManager.sol](https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol), mirrored in [docs.base.org spend permissions](https://docs.base.org/sdks/base-account/improve-ux/spend-permissions).

There is also `SpendPermissionBatch`, which shares one `account`/`period`/`start`/`end` across many `(spender, token, allowance)` triples and "can be approved with a single signature" [P]. Useful for multi-token or multi-tier products.

### Point-by-point

**Variable amount up to a cap? Yes.** `spend(SpendPermission memory, uint160 value)` takes an arbitrary `value`; `_useSpendPermission` accumulates `value` into the current period and reverts with `ExceededSpendPermission` only if `currentPeriod.spend + value > allowance` [P]. The SDK exposes this as an `amount` parameter, or `'max-remaining-charge'` to sweep the remainder ([subscription.charge](https://docs.base.org/sdks/base-account/reference/base-pay/charge)), and `prepareSpendCallData`'s `amount` is optional — "omit to spend the remaining allowance" [P]. **This is the single most important finding: the primitive is natively metered-capable.** The cap is a ceiling, not a fixed price.

**Does the pull work with the user fully offline? Yes.** `spend()` is guarded by `requireSender(spendPermission.spender)` — the *merchant's* backend sends the transaction. The user's involvement ended when they signed the EIP-712 payload. `approveWithSignature()` is entirely permissionless (any caller with a valid user signature), and is ERC-6492-compatible so it will deploy the user's account if it isn't deployed yet [P]. Base's docs are explicit: the spender can transfer "no additional prompts, pop-ups, or signatures needed from the user" [P].

**Revocation — how, and is it instant?** Three paths [P]:
- `revoke()` — called by the account. User-initiated.
- `revokeAsSpender()` — called by the spender. A merchant can cancel unilaterally.
- SDK wrappers `requestRevoke` (wallet popup) and `prepareRevokeCallData` (silent, spender-submitted).

Revocation sets `_isRevoked[hash] = true` and `isValid()` reads it directly, so it takes effect **the moment the revoke transaction is mined** — one block, no settlement lag, no grace period. It is also **permanent and non-reversible**: there is no un-revoke. Re-subscribing requires a new permission with a different `salt`.

**Insufficient balance at pull time — revert, partial fill, or queue?** **Full revert. No partial fill, no queue.** `_transferFrom` ends in `IERC20.safeTransferFrom(...)`, and the contract comments state it will "revert if transfer fails" [P]. Because the allowance accounting write (`_lastUpdatedPeriod[hash] = currentPeriod`) happens in the *same* transaction, a reverted transfer rolls the accounting back too — **a failed charge consumes no allowance, so retrying is safe and free.** This is materially better than a card decline. Base's docs confirm the three failure states you must handle: revoked/expired, insufficient balance, and period allowance exhausted ([charge on a schedule](https://docs.base.org/build-on-base/accept-payments/charge-on-a-schedule)).

**Can a permission be amended without a fresh user signature? No.** There are two amendment paths and both need the user:
- `approveWithRevoke(toApprove, toRevoke, expectedLastUpdatedPeriod)` — atomically swaps one permission for another, with a front-running guard on the old permission's spend. But it is `requireSender(permissionToApprove.account)`: **the user must send this transaction themselves** [P].
- Collect a new EIP-712 signature off-chain, then have the merchant submit `approveWithSignature` (permissionless) and `revokeAsSpender` on the old one. **The user signs but does not transact, and pays no gas.**

The second path is the practical one, and it is the crux of the product problem: **every plan upgrade past the cap costs you a user re-consent step.** There is no "raise the limit" primitive.

**Limits on active permissions per account?** **No cap in the contract** — approvals live in `mapping(bytes32 hash => bool)`, which is unbounded [P]. Whether the Base Account wallet UI or the `coinbase_fetchPermissions` RPC imposes a practical limit is **[U]** — the Coinbase Help page on this returns HTTP 403 to automated fetches and I could not read it.

**Gas sponsorship on the pull — can the merchant pay, not the user?** **The merchant already pays by default.** The pull is the *spender's* transaction, so its gas comes from the spender's account; the user never pays gas on a charge. On top of that, `subscription.charge()` accepts a `paymasterUrl` for ERC-7677 sponsorship of that transaction, and Base documents CDP as a paymaster provider ([sponsor gas](https://docs.base.org/sdks/base-account/improve-ux/sponsor-gas/paymasters)) [P]. So gas is a non-issue in both directions.

### The finding that most changes the plan: `SpendRouter`

The repo now contains [`SpendRouter.sol`](https://github.com/coinbase/spend-permissions/blob/main/src/SpendRouter.sol), a singleton that encodes `(executor, recipient)` into `extraData`, verifies `msg.sender == executor`, pulls via the manager, and forwards to `recipient` [P]. The repo carries two **Cantina audits dated March 2026** for it (`audits/Cantina-March-2026-SpendRouter.pdf`, `-2.pdf`) [P].

This matters because it means **the "Stipend triggers the charge, funds land in the merchant's treasury, Stipend never touches them" architecture is already shipped, audited Coinbase infrastructure.** That was going to be Stipend's structural claim to being non-custodial. It is now a library call. This is good news for regulatory posture (§6) and bad news for defensibility.

Corroborating this at the SDK layer: `subscription.charge()` takes an optional `recipient`, and "if not provided, USDC stays in the subscription owner wallet" [P].

---

## Q2 — Has Coinbase already built this?

**One-line answer: No. Coinbase has built the rails and explicitly declined to build the billing product — its own documentation says so in a warning box — but it has also removed the two adjacent products (Commerce, and any billing components in OnchainKit) that a competitor would have had to route around.**

### The "Accept Recurring Payments" guide is a primitive demo, not a billing product

The SDK surface is seven functions: `subscribe`, `getStatus`, `charge`, `revoke`, `prepareCharge`, `prepareRevoke`, `getOrCreateSubscriptionOwnerWallet` ([subscriptions overview](https://docs.base.org/sdks/base-account/reference/base-pay/subscriptions-overview)) [P]. `SubscriptionStatus` returns `isSubscribed`, `recurringCharge`, `remainingChargeInPeriod`, `currentPeriodStart`, `nextPeriodStart`, `periodInDays` [P]. That is a *permission inspector*, not a subscription object — there is no plan, no invoice, no customer, no ledger.

The error-handling section of the `charge` reference is, verbatim, a `try/catch` that logs and tells you to "update your database with the transaction hash" [P]. Retry policy is left entirely to the integrator.

Most tellingly, Base's own payments guide carries this warning [P]:

> **A spend permission is not a subscription scheduler.** Run billing from a durable job queue, use an idempotency key for each billing period, and reconcile the emitted transfer before marking an invoice paid.

That sentence is Coinbase drawing the line at the edge of Stipend's proposed scope. Everything on the far side of it — job queue, idempotency, invoice state, reconciliation — is unbuilt.

**Blunt assessment of overlap with Stipend's proposed scope:** of the eight capabilities in Q4, Coinbase's offering covers **zero** end-to-end. It covers the *charge execution* underneath all of them, plus status inspection and revocation. Call it 15–20% of the surface, and specifically the 15–20% that is easiest to build. The unbuilt 80% is also the part that is mostly undifferentiated CRUD — which is a warning about defensibility, not an opportunity.

### OnchainKit ships no billing components

Verified directly against the source tree, not the marketing site. `packages/onchainkit/src` contains: `api, appchain, buy, checkout, connected, core, earn, fund, identity, internal, minikit, nft, signature, styles, swap, token, transaction, ui, wallet` ([repo](https://github.com/coinbase/onchainkit)) [P]. **There is no `subscription`, `billing`, or `spend-permission` module.** `checkout` is one-time commerce.

### Coinbase Commerce is being shut down

Coinbase is retiring the self-custodial Coinbase Commerce product and migrating merchants to **Coinbase Business**, a custodial platform, with a **31 March 2026** cutoff and availability limited to US and Singapore legal entities [S]. Sources: [MoonPay migration guide](https://www.moonpay.com/newsroom/coinbase-commerce-shutdown-guide-for-merchants), [Coinbase Help](https://help.coinbase.com/en/transitioning-from-coinbase-commerce-to-coinbase-business).

⚠️ **Confidence caveat:** the official Coinbase Help page returns HTTP 403 to automated fetching, so I could not verify the dates and country list against Coinbase's own words. Every detail here is secondary. **Verify this before it goes in a deck** — it is load-bearing for the market story and it is the one major claim I could not reach a primary source for.

Commerce never had native recurring billing anyway; merchants stitched it with the Commerce API plus their own scheduler [V].

### A timing constraint worth knowing

The spend permissions doc carries a callout [P]:

> Spend Permissions for Base App Apps are coming soon and will be supported in a future update.

**Spend permissions do not yet work for mini-apps inside the Base App itself.** Today the primitive is only reachable from external web apps using the Base Account SDK. This closes off the single best distribution channel on Base — and re-opens it on Coinbase's timeline, plausibly before Feb 2027. See wedge 3.

---

## Q3 — Who else is building this?

**One-line answer: The category is crowded and the most dangerous competitor is not a crypto startup — it is Stripe, which already accepts USDC on Base as a payment method underneath the full Stripe Billing feature set.**

### The one that matters: Stripe

This is the finding that should reshape the plan.

Stripe stablecoin payments accept **"USDC (Tempo, Ethereum, Solana, Polygon and Base networks)"**, list **Recurring payments: Yes**, **Refunds / Partial refunds: Yes / Yes**, **Dispute support: No**, and support Checkout, Elements, Connect and **Billing** ([Stripe docs](https://docs.stripe.com/payments/stablecoin-payments)) [P]. Business availability is US plus ~30 EU/EEA countries, with EU/HK/MX/CH in private preview [P].

Critically, the integration is a `SetupIntent` with `payment_method_data[type]=crypto` and `usage=off_session`, whose resulting payment method becomes the `default_payment_method` on an ordinary Stripe `Subscription` ([setup guide](https://docs.stripe.com/billing/subscriptions/stablecoins)) [P].

**That architecture means every feature in Q4 comes for free.** Metered prices, proration, trials, invoices, Smart Retries, Stripe Tax, revenue recognition, webhooks — all of Stripe Billing operates unchanged on top of a crypto payment method. Stripe did not build a crypto billing product; it made crypto a payment method under the billing product it already had. That is a much stronger position than building up from the rails.

Announced 14 October 2025 ([Stripe blog](https://stripe.com/blog/introducing-stablecoin-payments-for-subscriptions)) [S]. Stablecoin *subscriptions* specifically still gate behind a `stablecoin_payments_preview` access request in the docs [P] — so it is **still in preview, not GA**, roughly eleven months on. That is Stipend's window.

**What Stripe does not do**, and this is where the remaining space lives [P]:
- **Settles in fiat.** "Stablecoin payments settle in your Stripe balance in your local currency." A merchant who wants to hold USDC cannot use this.
- **Custodial**, with Stripe as intermediary and Stripe's fees.
- **Redirects to `crypto.stripe.com`** to connect a wallet — it is a checkout flow, not a background pull, and it is not a Base Account experience.
- **US$10,000 per-transaction limit.**
- Restricted business geographies.

### The rest of the field

| Product | What it is | Chains | Base? | Usage-based? | Custody | Fees | Conf. |
|---|---|---|---|---|---|---|---|
| **Stripe Billing + stablecoins** | Full billing suite, crypto as a payment method | ETH, Solana, Polygon, **Base**, Tempo | **Yes** | **Yes** (full Stripe Billing) | Custodial, fiat settlement | ~1.5% [V] | **[P]** |
| **Radom** | Crypto-native billing platform | "12+ tokens, 10+ chains" | **[U]** | **Yes** — "flat rate, tiered, per-seat, usage-based, flat rate plus overage"; trials, add-ons, discounts | [U] | No billing-specific fee; per-tx crypto rate | [P] for features, [U] for Base |
| **Loop Crypto** | SaaS/creator subscription billing; ERC-20 `approve` to their contract | ETH, Polygon, Base | Yes | Fixed subs; USD-denominated via price oracle at charge time | Non-custodial | 0.75% [V] | [S]/[V] |
| **Superfluid** | Streaming money; "Superfluid Subscriptions" toolkit | 10–11+ EVM incl. Base | Yes (protocol) | Streaming ≠ metered | Non-custodial, self-hosted | — | [S] |
| **Sablier** | Token streaming: Lockup, Flow, Airdrops | 20–24+ chains incl. Base | Yes | No — streams, not usage | Non-custodial, permissionless | — | [S] |
| **Sphere** | Merchant API for USDC/USDT subscription billing | ETH, Base, Polygon, Solana | Yes | Fixed | Non-custodial | 0.5–1.0% | **[V]** |
| **Crossmint** | Checkout + subscription APIs | 40+ chains | Yes | Fixed | Hybrid, fiat fallback | 1–2% | **[V]** |
| **Helio / hel.io** | Subscriptions, escrow-based | Solana-first | No | Fixed | Escrow | — | [S]/[V] |
| **Spritz Finance** | Crypto → real-world bill pay (SMARTPay) | — | — | Not a merchant billing product | — | — | [S] |
| **Bridge.xyz, BVNK, Halliday, Beam, Eco, Privy** | Payouts / treasury / routing / wallet infra adjacent | various incl. Base | mixed | Fixed recurring | mixed | — | **[V]** |

Sources: [Radom crypto billing](https://www.radom.com/crypto-billing) [P]; [eco.com platform comparison](https://eco.com/support/en/articles/15232579-best-recurring-crypto-payment-platforms-2026-stablecoin-subscription-billing-compared) [V]; [Spark research](https://www.spark.money/research/recurring-stablecoin-payment-infrastructure) [V]; [Superfluid Subscriptions](https://superfluid.org/post/announcing-superfluid-subscriptions) [P].

**Two competitor notes worth flagging:**

1. **Radom is the closest direct threat after Stripe.** Its own site claims flat-rate, tiered, per-seat, **usage-based**, metered, and flat-rate-plus-overage billing, plus trials, add-ons, promo codes, recurring invoicing, webhooks, refunds and failed-payment reminders [P]. If Radom's Base support is real, "usage-based crypto billing" is not a green field. **Whether Radom supports Base is [U]** — their marketing page does not enumerate chains and I did not reach their chain list. **This is the highest-value open question in the whole report and should be answered first.**

2. **Loop Crypto's web presence is currently unreachable.** `loopcrypto.xyz`, `www.loopcrypto.xyz`, `docs.loopcrypto.xyz`, `app.` and `api.` all return **no DNS A record** from Google's resolver (8.8.8.8), while other hosts resolve fine from the same environment. WHOIS shows registry status `ACTIVE` with expiry 2029-11-02 and nameservers reverted to Namecheap defaults (`dns1/dns2.registrar-servers.com`). `loopcrypto.com` resolves to a different IP. Loop raised a $4M a16z-led seed and a later round led by VanEck and Fabric Ventures ([Blockworks](https://blockworks.com/news/loop-crypto-raises-vaneck-fabric)) [S]. **I am not asserting Loop is dead** — this could be a migration, a transient outage, or sandbox-specific. But the state of their DNS on 2026-09-08 is anomalous and worth 10 minutes of checking. Their mechanism, per secondary sources, is an ERC-20 `approve` to Loop's own contract [S] — a strictly weaker and more dangerous primitive than a spend permission (unbounded allowance, no period, no onchain accounting).

### Cross-chain context

Solana shipped native **Subscriptions & Allowances** — an audited, open-source reference program for recurring billing and delegated spending — to mainnet on **2 June 2026** [S] ([Crypto Economy](https://crypto-economy.com/solana-introduces-built-in-subscriptions-bringing-recurring-billing-directly-onchain/), [TheStreet](https://www.thestreet.com/crypto/innovation/solana-brings-subscription-billing-and-spending-limits-on-chain)). The delegated-pull primitive is becoming table stakes across L1s/L2s. A Base-only billing product is a bet that the *billing layer*, not the primitive, is where value accrues — which is the right bet, but it also means the eventual product must go multi-chain, and a Base-only wedge has a shelf life.

---

## Q4 — What does a merchant need beyond the pull?

**One-line answer: Most of Stripe Billing is easy-to-moderate on this primitive; three things are genuinely hard (refunds, proration past the cap, arrears recovery) and two are effectively blocked (tax jurisdiction, chargebacks) — and the single defining constraint is that *every charge is capped by an allowance the user set before they knew what they'd owe*.**

| Capability | Verdict | Why |
|---|---|---|
| **Failed-payment retry** | **Easy** | A reverted charge consumes no allowance (accounting and transfer are one atomic tx), so retries are free and idempotent. Strictly better than card retries — no decline fees, no issuer risk scoring, no card-network retry caps. |
| **Dunning (arrears recovery)** | **Hard** | Allowance resets to zero each period and **unused allowance does not carry forward** — period ranges are fixed at `[start + n·period, …]` ([accounting doc](https://github.com/coinbase/spend-permissions/blob/main/docs/SpendPermissionAccounting.md)) [P]. If January's charge fails all month, February's allowance must cover both January's arrears *and* February — which it usually can't, because the cap was sized for one month. **Arrears are structurally capped.** Recovering them needs a new, larger permission, i.e. a new user signature. This is the sharpest unsolved problem in the space and the best thing to build. |
| **Trials** | **Easy** | Set `start` to the trial end date, or just don't call `spend()`. `getCurrentPeriod` reverts with `BeforeSpendPermissionStart` before `start` [P], so the primitive enforces it for you. |
| **Invoices & receipts** | **Easy** | Entirely off-chain. The transaction hash is a cryptographic receipt; `SpendPermissionUsed` and `SpendRouted` events give you an auditable ledger for free [P]. Base's own docs tell merchants to "reconcile the emitted transfer before marking an invoice paid" — that reconciliation job *is* a product. |
| **Proration — upgrade within cap** | **Easy** | Charge the prorated delta immediately as a one-off variable pull. |
| **Proration — upgrade above cap** | **Hard** | Requires a new permission → new user EIP-712 signature. No gas cost to the user, but a consent interruption at the worst possible moment (the upgrade). No `increaseAllowance` exists. |
| **Proration — downgrade / credits** | **Hard** | The permission is strictly one-directional. A credit is either a refund (see below) or a bookkeeping entry you carry forward and net against future pulls. The latter is the right answer, and it's off-chain work. |
| **Refunds** | **Hard, and architecturally awkward** | There is no reverse-spend. A refund is a *push* from the merchant's treasury, needing merchant-side signing authority. **A genuinely non-custodial Stipend cannot execute a refund on the merchant's behalf** — it can only instruct. Base documents the merchant-executed flow ([refund a payment](https://docs.base.org/build-on-base/accept-payments/refund-a-payment)) [P]. Compare Stripe, which does refunds and partial refunds on stablecoins natively [P]. This is a real feature gap against Stripe. |
| **Tax handling** | **Effectively blocked** | Not a chain limitation — an identity one. Tax jurisdiction requires knowing where the customer is. A Base Account is an address; there is no billing address, no card BIN, no issuing country. Stripe Tax works because Stripe has that data. Any credible tax story here requires collecting KYC-grade location data, which drags in exactly the compliance surface §6 is trying to avoid. **Treat as out of scope, and tell merchants so.** |
| **Revenue reporting** | **Easy** | Every charge is a public, indexed event. Reporting is a subgraph plus a dashboard. Arguably better than card rails, where settlement reporting lags days. |
| **Webhooks** | **Easy** | Index chain events, emit HTTP. Standard work. |
| **Metered / usage aggregation** | **Easy to compute, hard to collect** | Metering itself is off-chain arithmetic. The pull supports the variable amount natively. **But overage above the cap is blocked without re-consent** — and for genuinely spiky usage (AI inference, API calls), the cap must be sized for the worst month, meaning you ask a user to authorize e.g. $500/mo to bill them $40. That consent-sizing problem is the core UX challenge of usage-based crypto billing, and nobody has solved it. |
| **Chargebacks / disputes** | **Blocked** | No reversal mechanism exists onchain. Stripe explicitly lists **Dispute support: No** for stablecoins too [P]. For merchants this is a *feature*; for consumer trust it is a gap that will eventually attract regulatory attention (§6). |
| **Multi-currency / FX** | **Moderate** | The primitive takes any ERC-20; the Base SDK is USDC-only [P]. Denominating in non-USD fiat needs an oracle at charge time — Loop reportedly does exactly this [S]. |

**Reading of this table:** the primitive is a good one. It is not the bottleneck. The bottleneck is that most of what remains is ordinary billing CRUD that a competent team ships in a quarter — which means the moat has to come from the three Hard rows, not the seven Easy ones.

---

## Q5 — Is the market reachable?

**One-line answer: I could not size it, and what I could find is discouraging in the near term — the last official Base Account figure is 185k from July 2025, and spend permissions do not yet work inside the Base App, which is where the users are.**

**Base Accounts:** the only figure I found from an official Coinbase/Base source is **"over 185k accounts"** — existing Coinbase Wallet Smart Wallet users auto-upgraded to Base Accounts, from the [Base Account SDK launch post, 16 July 2025](https://blog.base.dev/base-account-sdk) [P]. That is **14 months stale** and I could not find a refreshed number. **[U]**

**Base App users:** a secondary source puts Base App at ~5 million active users as of May 2026 [S], which I could not corroborate against Coinbase's own reporting and would not put in a deck. Coinbase's platform-wide figure of 8.2M monthly transacting users (Q1 2026) [S] is a different, much broader metric. **[U]**

**Base Pay volume:** **[U]**. I found no published Base Pay-specific transaction volume. A secondary source cites the Base app "routinely processes over $10 million in daily transactions" with a one-day high of $1.21bn [S], but that is chain/app activity, not merchant payments. The most concrete adoption fact is that **Shopify integrated Base Pay**, announced July 2025, with 1% USDC cashback for US consumers [S].

**The distribution problem.** Two facts stack badly:
1. Spend permissions are not yet available to apps inside the Base App ("coming soon") [P] — so the primitive can't reach Base App's audience today.
2. Base's own accelerator page shows Batches runs twice yearly, 8-week virtual programs with $100K investment ([base.org/batches](https://www.base.org/batches)) [P]. Batch 004 applications closed 9 Sep 2026, Demo Day 17 Nov 2026. **Batch 005 is not yet announced [U]**, but ~Feb 2027 is consistent with the cadence.

Between now and Feb 2027 the addressable population is "users of external web apps that integrated the Base Account SDK." That is small, and I cannot size it.

**Merchant categories that plausibly want this today**, ranked by how real the demand is:

1. **Crypto-native API and infrastructure companies** — the strongest category, because they already bill crypto-native customers who hold USDC, and many cannot easily use Stripe. Loop's published customer list is the best available evidence of who these buyers are: **Pinata, Neynar, Paragraph, Kaito, ETHGlobal, ENS**, with "50+ of the top web3 companies" [S]. These are real named companies with real recurring revenue and metered usage. **This is the beachhead.**
2. **AI/agent API providers** — genuinely metered, genuinely spiky, and Base is actively courting them with x402 (see wedge 1). Overlaps heavily with (1).
3. **Creator subscriptions / paid communities** — Base App's Farcaster-powered social feed and USDC tipping make this natively plausible, but it is gated on the Base App spend-permission rollout.
4. **Merchants who want to *hold* USDC** — the one group Stripe structurally cannot serve, since Stripe settles to fiat. Crypto-native treasuries, DAOs, offshore SaaS.
5. **Consumer SaaS generally** — not reachable. These merchants have Stripe and no reason to leave.

**Honest read:** the market today is "crypto-native companies billing crypto-native customers," which is a few hundred to a few thousand businesses globally. That is enough for a seed-stage wedge and an accelerator application. It is not obviously enough for a venture outcome without the Base App channel opening.

---

## Q6 — Regulatory shape

**One-line answer: If Stipend never takes custody or control of funds, the strongest argument is that it is a software/instruction provider rather than a money transmitter — but that turns entirely on architecture details, and there are at least three live open questions (Reg E authorization, the payment-processor exemption, GENIUS Act interaction) that need a lawyer.**

**The controlling test is control, not autonomy.** FinCEN's 2019 CVC guidance (**FIN-2019-G001**) applies a control-based test: a person with "total independent control" over customer value is a money transmitter; a provider of "delivery, communication, or network access" services that never controls funds generally is not ([Jones Day](https://www.jonesday.com/en/insights/2019/06/fincen-consolidates-guidance), [Ballard Spahr](https://www.moneylaunderingnews.com/2019/05/new-fincen-cryptocurrency-guidance-provides-comprehensive-overview-of-bsa-application-to-crypto-businesses/)) [S]. Applied to agentic payments: *"Custodial agents transmit; non-custodial agents instruct"* ([Astraea Law](https://astraea.law/insights/agentic-payments-money-transmitter-license)) [S].

**Architecture is dispositive, and there is a fork in the road.** The Base SDK's default `subscription.charge()` path lands USDC in the **subscription owner wallet** unless a `recipient` is passed [P]. If Stipend operated that wallet, Stipend would control merchant funds — almost certainly transmission. Using `SpendRouter`, where the executor (Stipend) is distinct from the recipient (merchant treasury) and funds never rest anywhere Stipend controls [P], is the version with a defensible non-custodial story. **This is a design decision that has to be made on day one and never violated**, including in edge cases like refunds, failed forwards, and fee collection. Taking a percentage fee out of the flow is the most likely way to accidentally become custodial.

### Questions for counsel

**Money transmission**
1. Does holding a *spender key* that can unilaterally move user funds — without ever holding those funds — constitute "control" under FIN-2019-G001, even when settlement is atomic to a third party? This is the central question and I found no authority squarely on it. **The honest answer is that this is unsettled.**
2. Does the payment-processor exemption at **31 CFR 1010.100(ff)(5)(ii)(B)** reach a stablecoin flow? It requires facilitation through a "bank-based clearance and settlement system" by agreement with the seller, and fails if you pool funds, hold float, or intermediate both sides [S]. A blockchain is arguably not a bank-based system. Fact-specific; do not assume it.
3. State-by-state: which states' money-transmission definitions capture "monetary value" broadly enough to reach an executor key? What are the NYDFS BitLicense and California DFPI positions specifically? Net-worth minimums, surety bonds and per-state licensing are described as "the expensive part" [S].

**Consumer protection**
4. **Regulation E / EFTA.** How does a standing "spend up to $X per month" authorization map onto per-transaction authorization protections? Astraea flags this as an open frontier issue and recommends designing clear, auditable, revocable consumer authorization with per-transaction limits *now*, ahead of rulemaking [S]. Stipend should over-build the consent audit trail — every permission signature, every charge, every revocation, timestamped and exportable. That is cheap now and expensive to retrofit.
5. With **no chargeback mechanism** (§4), what recourse does a consumer have for an unauthorized or erroneous pull, and does that absence create UDAP exposure for the billing layer that orchestrated it?

**Stablecoin-specific**
6. **GENIUS Act (2025)** creates a federal regime for payment stablecoins (reserve, redemption, disclosure) that *adds to* rather than replaces money-transmission analysis [S]. Does routing USDC as an agent for merchants trigger any obligation, or does that sit entirely with Circle?

**Ancillary**
7. Merchant-of-record: is Stipend ever the MOR, or always disclosed agent? MOR status pulls in tax collection (which §4 says is effectively blocked) and consumer liability.
8. Sanctions/OFAC screening obligations on merchant and payer addresses, even in a non-custodial posture.
9. Non-US: does UK/EU treatment (PSD2 payment initiation services, MiCA) differ enough to make non-US launch harder, easier, or a different product? Notably, PSD2's *payment initiation service provider* concept is a close analogue to "instructs but does not hold" and may be a better-fitting regime than US money transmission.

**No legal conclusion offered.** The above is a question list, as requested.

---

## §7 — Recommendation

### Against the stated kill criteria: both fail to trigger

**Criterion A** — *"spend permissions cannot express variable-amount pulls AND an existing product already covers fixed subscriptions on Base competently."*
**Not met.** The first conjunct is false: `spend(permission, value)` takes an arbitrary value up to the per-period cap, and the SDK exposes it directly [P]. The primitive is natively variable-amount. (The second conjunct is arguably true — Stripe, Loop and Radom all cover fixed subscriptions — but the criterion requires both.)

**Criterion B** — *"Coinbase's own recurring-payments offering already spans most of Question 4's list."*
**Not met, and not close.** Coinbase covers zero of the eight end-to-end, ships no billing components in OnchainKit, is shutting down Coinbase Commerce, and states in its own documentation that "a spend permission is not a subscription scheduler" [P].

**So: go, by the criteria as written.**

### But the criteria miss the actual risk, and you should know that before you commit

The kill criteria were written to test *Coinbase*. The threat is *Stripe*. Stripe already accepts USDC on Base as a `SetupIntent`-backed payment method underneath the complete Stripe Billing feature set [P] — metered prices, proration, trials, Smart Retries, invoices, tax, revenue recognition, webhooks, refunds. Stipend's entire Q4 roadmap ships as a checkbox in a product a million merchants already use.

Had the kill criteria said *"or any existing product already spans most of Question 4's list on Base,"* this would be a no-go on the general-purpose billing thesis.

Three further facts compress the space:
- **`SpendRouter` (audited March 2026) already implements executor/recipient separation** [P] — the non-custodial merchant-direct architecture is now Coinbase infrastructure, not a Stipend invention.
- **Radom claims usage-based, metered and overage billing today** [P], though its Base support is unverified **[U]**.
- **Delegated-pull primitives are becoming table stakes across chains** — Solana shipped native subscriptions in June 2026 [S] — so a Base-only product has a limited shelf life.

**Therefore: go, but not on "Stripe Billing for Base."** That framing loses to Stripe on features, to Radom on billing-model breadth, and to Coinbase on rails. Go only on the narrow ground where Stripe's architecture *cannot* follow: **merchant-direct USDC settlement with no fiat conversion, no custody, and no per-transaction ceiling**, for customers Stripe's compliance perimeter excludes.

### The three narrowest wedges

**1. Metered billing for AI/API companies — own the allowance-headroom problem.**
The unsolved problem in usage-based crypto billing is not metering; it is that the cap must be authorized *before* usage is known. Sizing it for the worst month means asking for $500 to bill $40; sizing it tight means failed charges. The product is the headroom engine: forecast next period's usage, pre-emptively request a larger permission *before* the charge fails, and degrade gracefully when it does. Nobody does this — Stripe doesn't need to (no caps on cards), and Coinbase explicitly punts. Buyers are the Loop customer profile: Pinata, Neynar, Kaito, ETHGlobal [S]. **Test first:** does Radom support Base, and does its usage-based billing handle overage above an onchain cap?

**2. Failure recovery and re-authorization — the "card updater" for spend permissions.**
Four failure modes exist (revoked, expired, insufficient balance, allowance exhausted), each needing a different response, and one — arrears exceeding next period's cap — is *structurally unrecoverable* without a new signature (§4). Build the detector, the classifier, and the one-tap re-authorization flow. This is the highest-value Hard row in Q4, it is where Base's docs stop with a warning box, and it compounds: every merchant's recovery data makes the forecasting better. Ship it standalone — it works *alongside* a merchant's existing billing system rather than replacing it, which is a far easier sale than displacing Stripe.

**3. Be ready for Base App mini-app spend permissions on day one.**
Spend permissions inside Base App apps are "coming soon" [P]. When that ships, every mini-app gets a subscription primitive and none gets a billing layer — and it is the one distribution channel Stripe structurally cannot enter. Batch 005 at ~Feb 2027 is plausibly the right moment. **This is a timing bet, so treat it as one:** build wedges 1 and 2 for external web apps where revenue exists today, and keep the mini-app SDK shallow enough to ship the week the callout comes down. Do not build the company on this alone — the rollout date is **[U]** and it is Coinbase's to set.

---

## §8 — What I could not determine

Listed explicitly rather than inferred, as requested.

1. **Does Radom support Base?** Their billing page enumerates billing models but not chains. **This is the single highest-priority open question** — Radom claiming usage-based billing on Base would materially weaken wedge 1.
2. **Radom's custody model and pull mechanism.** Not disclosed on the pages I read.
3. **Loop Crypto's operational status.** All `loopcrypto.xyz` hostnames returned no DNS A record on 2026-09-08 from this environment, while the domain is registry-`ACTIVE` through 2029 with nameservers on Namecheap defaults. Could be migration, outage, or environment-specific. Unresolved — check directly.
4. **Current Base Account count.** Last official figure is 185k (July 2025). No refreshed number found.
5. **Base App user count.** ~5M is secondary and uncorroborated.
6. **Base Pay transaction volume.** No published figure found.
7. **When spend permissions arrive for Base App mini-apps.** Docs say "coming soon" with no date. Wedge 3 depends on this.
8. **Whether any limit exists on active permissions per account** beyond the contract (which has none). The Coinbase Help page returns HTTP 403 to automated fetches.
9. **Coinbase Commerce shutdown specifics** — dates and country list are secondary only; the official Coinbase Help page was unreachable (403). Verify before citing.
10. **Base Batches 005 dates, existence, and theme.** Only 004 is published. ~Feb 2027 is inferred from the stated twice-yearly cadence, not confirmed.
11. **Whether Stripe stablecoin subscriptions support metered prices in practice.** Architecturally they should (it is an ordinary `Subscription` with a crypto `default_payment_method`), but I found no explicit confirmation, and preview products often carry undocumented restrictions. Worth confirming — it is load-bearing for how much room wedge 1 actually has.
12. **Stripe's actual fee on stablecoin subscriptions.** The 1.5% figure is vendor-marketing **[V]**, not from Stripe's own pricing page.
13. **Actual per-transaction gas cost of a `spend` + `route` on Base at current fees.** Matters for viability at small ticket sizes (creator subscriptions at $3/mo). Easily measured on testnet in Phase 1.

---

## Sources

**Primary — code and official docs**
- [SpendPermissionManager.sol](https://github.com/coinbase/spend-permissions/blob/main/src/SpendPermissionManager.sol)
- [SpendRouter.sol](https://github.com/coinbase/spend-permissions/blob/main/src/SpendRouter.sol)
- [Spend Permission Accounting](https://github.com/coinbase/spend-permissions/blob/main/docs/SpendPermissionAccounting.md)
- [coinbase/spend-permissions repo](https://github.com/coinbase/spend-permissions) (audit filenames)
- [Use Spend Permissions](https://docs.base.org/sdks/base-account/improve-ux/spend-permissions)
- [Accept Recurring Payments](https://docs.base.org/sdks/base-account/guides/accept-recurring-payments)
- [Subscriptions Overview](https://docs.base.org/sdks/base-account/reference/base-pay/subscriptions-overview) · [subscription.charge](https://docs.base.org/sdks/base-account/reference/base-pay/charge) · [subscription.getStatus](https://docs.base.org/sdks/base-account/reference/base-pay/getStatus)
- [Charge on a Schedule](https://docs.base.org/build-on-base/accept-payments/charge-on-a-schedule) · [Refund a Payment](https://docs.base.org/build-on-base/accept-payments/refund-a-payment) · [Settle Usage-Based Payments](https://docs.base.org/build-on-base/accept-payments/settle-usage-based-payments)
- [Sponsor Gas / Paymasters](https://docs.base.org/sdks/base-account/improve-ux/sponsor-gas/paymasters)
- [coinbase/onchainkit](https://github.com/coinbase/onchainkit)
- [Stripe: Stablecoin payments](https://docs.stripe.com/payments/stablecoin-payments) · [Stripe: Subscriptions with stablecoins](https://docs.stripe.com/billing/subscriptions/stablecoins)
- [Radom Crypto Billing](https://www.radom.com/crypto-billing)
- [Base Batches](https://www.base.org/batches)
- [Base Account SDK launch, 16 Jul 2025](https://blog.base.dev/base-account-sdk)
- [Superfluid Subscriptions](https://superfluid.org/post/announcing-superfluid-subscriptions)

**Secondary**
- [Stripe: Introducing stablecoin payments for subscriptions](https://stripe.com/blog/introducing-stablecoin-payments-for-subscriptions)
- [MoonPay: Coinbase Commerce shutdown migration guide](https://www.moonpay.com/newsroom/coinbase-commerce-shutdown-guide-for-merchants) · [Coinbase Help (403 to automated fetch)](https://help.coinbase.com/en/transitioning-from-coinbase-commerce-to-coinbase-business)
- [Blockworks: Loop Crypto raises round led by VanEck, Fabric](https://blockworks.com/news/loop-crypto-raises-vaneck-fabric)
- [Crypto Economy: Solana built-in subscriptions](https://crypto-economy.com/solana-introduces-built-in-subscriptions-bringing-recurring-billing-directly-onchain/) · [TheStreet](https://www.thestreet.com/crypto/innovation/solana-brings-subscription-billing-and-spending-limits-on-chain)
- [Astraea Law: Does your agentic-payments startup need an MTL?](https://astraea.law/insights/agentic-payments-money-transmitter-license)
- [Jones Day: FinCEN consolidates guidance](https://www.jonesday.com/en/insights/2019/06/fincen-consolidates-guidance) · [Ballard Spahr on FIN-2019-G001](https://www.moneylaunderingnews.com/2019/05/new-fincen-cryptocurrency-guidance-provides-comprehensive-overview-of-bsa-application-to-crypto-businesses/)
- [The Block: Coinbase unveils Base App](https://www.theblock.co/post/362713/coinbase-unveils-base-app-rebrands-wallet-as-all-in-one-social-and-trading-platform)

**Vendor-marketing — leads only, treat with suspicion**
- [eco.com: Best recurring crypto payment platforms 2026](https://eco.com/support/en/articles/15232579-best-recurring-crypto-payment-platforms-2026-stablecoin-subscription-billing-compared)
- [Spark: Recurring stablecoin payment infrastructure](https://www.spark.money/research/recurring-stablecoin-payment-infrastructure)
- [qbitflow: Coinbase alternatives 2026](https://qbitflow.app/blog/8-coinbase-alternatives-2026)
