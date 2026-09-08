# Stipend — Phase 0.5 Addendum

**Date:** 2026-09-08
**Scope:** Four open items from [phase0-report.md](phase0-report.md) §8. Desk research only, no code, no transactions sent.
**Grading:** same convention as the main report — **[P]** primary, **[S]** secondary, **[V]** vendor-marketing, **[U]** undetermined.

Closes §8 items 1, 2, 3 (partially), 11, 12 and 13. One correction to the main report is at the end.

---

## 1. Radom's billing mechanism: pull or push?

**One-line answer: Both — Radom supports an unattended pull it calls an "automated EVM subscription," authorized by an ordinary ERC-20 allowance granted to a Radom subscription contract, and a separate email-invoice mode where the customer pays each cycle; the pull path is custodial, with funds landing in a Radom-held balance the merchant withdraws.**

The decisive evidence is in the webhook schemas, not the marketing pages. Radom's `subscriptionType` is a tagged union with exactly two variants [P]:

```
subscriptionType SubscriptionType required
  automatedEVMSubscription AutomatedEVMSubscription required
    buyerAddress                 string   required
    subscriptionContractAddress  string   required
    recommendedAllowanceDuration integer  nullable
    emailAddress                 string   nullable
  emailInvoiceSubscription EmailInvoiceSubscription required
    emailAddress                 string   required
```

Source: [subscription payment reminder](https://docs.radom.com/webhooks/subscription-payment-reminder), [subscription payment overdue](https://docs.radom.com/webhooks/subscription-payment-overdue).

**It is a pull, and the primitive is an ERC-20 allowance — not spend permissions.** The `subscriptionPaymentAttemptFailure` event is documented as: *"This event is emitted when an **autopay** subscription payment fails. This can be due to an insufficient balance or an insufficient allowance."* Its `failureReason` enum is [P]:

```
insufficientAllowance | insufficientBalance | gasCostGreaterThanSubscriptionCost
```

Source: [subscription payment attempt failure](https://docs.radom.com/webhooks/subscription-payment-attempt-failure).

`insufficientAllowance` as a first-class failure reason, plus `subscriptionContractAddress` and `recommendedAllowanceDuration` (Radom tells the customer how many billing periods' worth of allowance to approve), makes the architecture unambiguous: the customer signs one ERC-20 `approve` to a Radom-operated subscription contract, and Radom's backend pulls against that allowance on a schedule. **`recommendedAllowanceDuration` is Radom's answer to the same headroom problem described in the main report — and it is a crude one: ask for N periods up front and hope.**

**Base is confirmed at the API level.** `Base` and `BaseTestnet` are members of the `Network` enum across every subscription webhook payload [P]. This independently confirms the correction you supplied.

**Radom is custodial in this flow.** Their API exposes `GET /balance` returning per-`treasuryId` merchant balances, alongside `withdrawal-accounts`, `payout`, and — most tellingly — `fbo-organizations/transfer-organization-balance` [P]. FBO ("for benefit of") is the standard custodial-omnibus construct. The webhook payment summary carries `grossAmount`, `radomFeeAmount`, `netAmount` [P], i.e. the fee is netted out of the flow before the merchant sees it. Every subscription type in the schema is prefixed `Managed*` (`ManagedPayment`, `ManagedPaymentMethod`, `ManagedSubscriptionPeriod`). Funds route through Radom and settle to a Radom-held balance.

**Retry behaviour, for comparison:** *"Subscription payments are retried for a 3 day grace period after the payment due date"* [P] — a fixed, non-configurable window.

**What this means for wedge 1.** Wedge 1 is **contested on features, open on architecture.** Radom genuinely ships usage-based and metered billing on Base today, so "usage-based crypto billing on Base" is not a green field and should not be claimed as one. But Radom does it custodially, on an ERC-20 allowance that is unbounded per period, has no on-chain accounting, no automatic per-period reset, and no expiry — strictly weaker consumer protection than a spend permission. The remaining defensible ground is the same one the main report identified: **non-custodial, merchant-direct, with a bounded and self-resetting authorization.** That is a real difference, but it is now a difference in *architecture and consumer safety*, not in *feature coverage* — which is a harder story to sell to a merchant and an easier one to sell to Base.

---

## 2. Loop Crypto's operational status

**One-line answer: Dead as a standalone product — the team joined Lead Bank on 10 December 2025, merchants were given 60 days to migrate off ending 13 February 2026, and the web infrastructure was torn down on 7 September 2026, the day before I checked.**

The DNS anomaly resolves, and the timeline is consistent.

**The corporate event.** Lead Bank announced on **10 December 2025** that it was welcoming "Eleni Steinman, Shane van Coller, and the entire Loop team to Lead," describing Loop as having "built a payment processor that enables businesses and e-commerce platforms to use stablecoin rails" ([Lead Bank](https://www.lead.bank/blog-posts/loop-crypto-joins-lead)) [P]. The announcement is written as a team arrival and does not state the transaction type or address the product's fate. Coverage: [The Block](https://www.theblock.co/post/382124/a16z-backed-lead-bank-adds-loop-crypto-to-inner-circle-with-eye-on-scaling-stablecoins-and-payments) [S].

**The product wind-down.** Loop's own news page announced merchants had 60+ days to wind down usage, **ending 13 February 2026**, with a CSV export of historical payment data on confirmation of migration [S]. That page (`docs.loopcrypto.xyz/news`, titled "Loop is joining Lead Bank") is still in search indexes but is no longer reachable — see below.

**The infrastructure teardown, dated precisely.** The `loopcrypto.xyz` zone's SOA serial is `1788752309`, which decodes as a Unix timestamp to **7 September 2026 03:38:29 UTC — the day before this check** [P]. The current state of the zone:

- **No `A`, `AAAA` or `CNAME`** for the apex or for `www`, `app`, `api`, `docs`, `dashboard`, `checkout`, queried directly against the authoritative nameservers and confirmed identically via Google (8.8.8.8), Cloudflare (1.1.1.1), Quad9 (9.9.9.9) and OpenDNS.
- **`MX` records intact**, pointing at Google Workspace, with an SPF record including HubSpot.
- Domain registry status `ACTIVE`, expiry 2029-11-02.
- The `LoopCrypto` GitHub organisation now reports **`public_repos: 0`**, last updated 2026-05-16 [P], though search engines still index nine repositories (`loop-core-sdk`, `loop-connect-examples`, `loop-sdk`, `loop-next`, `loop-demo-app`) [S] — the repos were taken private or deleted after indexing.

Email preserved, web and code removed, on a zone edited yesterday. That is a deliberate, staged decommissioning of a product whose merchants left nineteen months ago, not an outage.

**Conclusion: migrated, then shut down.** The team and the capability live on inside Lead Bank; the merchant-facing product does not. Two consequences worth carrying forward. First, the customer list cited in the main report as evidence of buyer demand (Pinata, Neynar, Paragraph, Kaito, ETHGlobal, ENS) is a list of companies that **were forced to migrate off crypto-native subscription billing in early 2026** — they are reachable, they have a live memory of the problem, and they are worth interviewing before anything is built. Second, the most direct comparable in this category exited to a bank rather than scaling as independent billing infrastructure. That is one data point, not a verdict, but it is the relevant one.

---

## 3. Do metered prices work on Stripe's stablecoin subscriptions?

**One-line answer: Cannot be determined from public sources — Stripe's own support matrix resolves only to "Subscriptions: private preview" and says nothing about price types — but two documented constraints bound the answer regardless, and one of them is a hard ceiling on exactly the customers wedge 1 targets.**

**What Stripe actually publishes.** The payment-method support matrix gives this row for stablecoins [P]:

| | Connect | Checkout | Payment Links | Payment Element | Express Checkout | Mobile Element | **Subscriptions** | **Invoicing** | Customer Portal |
|---|---|---|---|---|---|---|---|---|---|
| Stablecoin Payments | ✓ | ✓ | ✓ | ✓ | — Unsupported | ✓ | **(Private preview)** | **✓ Supported¹** | (Private preview) |

¹ *"Supported with `send_invoice` [collection method](https://docs.stripe.com/billing/collection-method) subscriptions."*

And for API support [P]: PaymentIntents ✓, **SetupIntents (Private preview)**, Manual capture ✓, **Setup future usage (Private preview)**, Requires redirect: Yes.

Source: [Payment method support](https://docs.stripe.com/payments/payment-methods/payment-method-support).

**No document I could reach states any restriction on metered or usage-based prices with `payment_method_data[type]=crypto`, and none states that they work.** I checked the stablecoin payments overview, the accept-stablecoin-payments guide, all three integration variants of the stablecoin subscriptions guide, the support matrix, and the launch blog post. The subscriptions guide walks through creating a **Flat rate** price and never mentions other pricing models. **Genuinely undetermined [U]**, and it will stay that way until someone gets preview access — which is the cheapest way to resolve it, since access is a one-line request from the docs page.

**Two bounding constraints, both documented.**

**(a) The `send_invoice` footnote is the sharper signal.** The only *generally available* stablecoin path for recurring billing is invoicing with the `send_invoice` collection method — the customer receives an invoice and pays it. Automatic off-session charging (`charge_automatically`), which is what metered billing requires in practice, depends on SetupIntents and setup-future-usage, and **both are marked private preview** [P]. So the unattended-pull capability Stripe built is still gated, eleven months after announcement. This is consistent with the main report's read of the window, and slightly widens it.

**(b) The $10,000 per-transaction limit is a hard ceiling on metered invoices.** Stripe states: *"Customer transaction limits are US$10,000 per transaction"* ([Stripe docs](https://docs.stripe.com/payments/stablecoin-payments)) [P]. A metered invoice is a single charge, so **any customer whose usage exceeds $10,000 in a billing period cannot be collected in one transaction.** For the AI/API companies wedge 1 targets, five-figure monthly usage is normal, not exceptional. This constraint applies whether or not metered prices are technically supported, and it does not exist on a spend permission, where `allowance` is a `uint160`.

Closing §8 item 12: **the widely-cited 1.5% stablecoin fee and the $100,000 monthly limit are both unverified.** Neither appears in any Stripe source I could reach; the $10,000 per-transaction figure is the only limit Stripe itself publishes. Do not cite the others.

*Noted in passing:* the support matrix says manual capture is **✓ Supported** for stablecoins while the stablecoin payments overview says **"Manual capture support: Not supported."** Stripe's docs contradict each other here. Immaterial to the decision, but it is a reminder that this product's documentation is still preview-grade.

---

## 4. Gas cost of a charge on Base

**One-line answer: Roughly $0.002–$0.011 per charge all-in, which is negligible — gas is not a constraint on this business at any realistic ticket size, and a $3/month creator subscription pays about 0.3% in gas versus roughly 13% for the same charge on Stripe's card rates.**

Measured from **real mainnet transactions**, not estimates. I identified live calls to the deployed `SpendPermissionManager` (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`) by reading its event logs over ~5.3 hours via the public Base RPC, then pulled receipts. Function selectors were computed locally with `cast sig` and matched exactly: `0x415a9735` = `spend(...)`, `0xb9ffc8e1` = `approveWithSignature(...)`. No transactions were sent.

| Operation | n | L2 gas (min / median / max) | L1 data fee (median) | Cost at floor | Cost at observed prices |
|---|---|---|---|---|---|
| **`spend()`** — the recurring charge | 9 | 106,454 / **121,973** / 126,773 | ~$0.000011 | **$0.0018** | **$0.0076** (range $0.0016–$0.0087) |
| **`approveWithSignature()`** — one-time setup | 8 | 93,025 / **96,769** / 96,793 | ~$0.000015 | $0.0015 | $0.0060 |

At ETH = **$2,491.90** ([Coinbase spot](https://api.coinbase.com/v2/prices/ETH-USD/spot), 2026-09-08). Direct `spend()` calls only — I excluded transactions arriving via the ERC-4337 EntryPoint (`handleOps`, 275k–1.7M gas), since those bundle unrelated user operations and a merchant backend would not use that path.

**Base fees are effectively pinned at the floor.** `baseFeePerGas` was **0.005 gwei** in all 30 daily samples over the past 30 days, and in 71 of 72 samples taken every ~20 minutes over the past 24 hours (single outlier: 0.0077 gwei). Observed *effective* gas prices on real transactions were 0.006–0.025 gwei, the spread being priority tips. **The L1 data fee is irrelevant** — roughly $0.00001, four orders of magnitude below the L2 execution cost.

**Adding SpendRouter: estimated, not measured.** `SpendRouter` **is not deployed** — the repo README lists its address as `TBD` (see the correction below) — so I could not measure it. It adds one ERC-20 `transfer` from the router to the merchant recipient, one event, and the `extraData` decode: **approximately +30,000–55,000 gas**, giving a total near **150,000–180,000 gas**, or roughly **$0.002–$0.011** per charge. Flagged as an estimate.

**Where it stops making sense.** Taking the pessimistic end (~$0.011/charge with routing at observed tip-inclusive prices):

| Ticket | Gas as % of charge | Stripe card equivalent (2.9% + $0.30) |
|---|---|---|
| $0.25 | 4.4% | 122% |
| $0.50 | 2.2% | 63% |
| $1.00 | 1.1% | 32.9% |
| **$3.00** | **0.37%** | **12.9%** |
| $10.00 | 0.11% | 5.9% |
| $50.00 | 0.02% | 3.5% |

**Creator subscriptions at a few dollars a month are comfortably viable** — the exact segment card rails price out. Gas crosses 1% of the ticket around **$1.10** and only becomes awkward below roughly **$0.25–0.50 per charge**. Sub-$1 micropayments are where batching would start to matter, and that is well below anything in the plan.

**Three caveats worth carrying.**

1. **The sample is 30 days.** Base has historically seen congestion spikes well above the floor. My data cannot rule them out, and I did not sample far enough back to characterise the tail. Even so, a 10× fee spike puts a routed charge near $0.11 — still under 4% of a $3 ticket.
2. **The merchant must hold ETH on Base to pay gas.** This is real operational friction — a gas tank that silently empties stops all billing — and it is precisely the kind of thing a billing layer should abstract away with a paymaster. Worth treating as a product surface, not a footnote.
3. **Gas is not the binding constraint anywhere in this business.** The constraints identified in the main report — the allowance ceiling, arrears recovery, re-consent on upgrade — are all economic and UX constraints, not cost constraints. Item 13 closes as a non-issue.

---

## Correction to the main report

**`SpendRouter` is audited but not yet deployed.** The repo README lists `SpendPermissionManager` at `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` across Base, Ethereum, Optimism, Arbitrum, Polygon, Zora, BSC and Avalanche, but under `### SpendRouter` it lists the address as **`TBD`** [P] ([README](https://github.com/coinbase/spend-permissions/blob/main/README.md)).

Phase 0 §Q1 described the executor/recipient separation as "already shipped, audited Coinbase infrastructure." **"Audited but unshipped" is the accurate statement** — the two Cantina audits (2026-03-18 and 2026-03-21) are real, but the contract is not live. This cuts both ways and neither is decisive: the non-custodial merchant-direct architecture is not yet available to build on today, so Q6's preferred design is not currently implementable as described; but it is clearly coming, so it remains a poor basis for differentiation. The Phase 0 conclusion does not change.

---

## Remaining open items from §8

Still open: **4** (current Base Account count), **5** (Base App user count), **6** (Base Pay volume), **7** (when spend permissions reach Base App mini-apps), **8** (any wallet-side cap on active permissions), **9** (Coinbase Commerce shutdown specifics — secondary sources only), **10** (Batch 005 dates).

Item **3** is now partially resolved: Stripe's metered support remains **[U]**, but the bounding constraints in §3 above are documented and may be sufficient to plan against without preview access.
