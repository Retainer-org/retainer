Project: Stipend — Phase 0 investigation. No code.

You are investigating whether to build a recurring and usage-based stablecoin billing product on Base, targeting the Base Batches 005 accelerator (applications expected around February 2027). The output of this phase is a written report with a go/no-go recommendation. Do not scaffold a repo, write contracts, install dependencies, or create any application code. If you find yourself opening an editor to write implementation, stop.

Product hypothesis to test: merchants want to charge users recurring or metered USDC on Base without holding custody of user funds, and Base Account spend permissions are the primitive that makes this possible. Stipend would be the billing layer above that primitive — schedules, retries on failure, proration, invoices, refunds, analytics — the way Stripe Billing sits above card rails.

Question 1 — what can spend permissions actually express?
Start at docs.base.org and work through the Base Account guides, specifically the spend permissions, recurring payments, sub-accounts and gas sponsorship pages, then read the underlying contracts on GitHub. Answer concretely: what parameters does a permission take (token, cap, period, spender, expiry)? Can a merchant pull a variable amount up to a cap, or only a fixed amount? Does the pull work with the user fully offline? How is a permission revoked, and does revocation settle instantly? What happens when the user's balance is insufficient at pull time — does it revert, partially fill, or queue? Can a permission be amended without a fresh user signature? Are there limits on how many active permissions one account can hold? Can gas be sponsored on the pull transaction so the merchant pays, not the user?

Question 2 — has Coinbase already built this?
Read the "Accept Recurring Payments" guide end to end and establish whether it is a complete billing product or a primitive demo. Check Coinbase Commerce's current feature set for subscriptions. Check whether OnchainKit ships billing components. Be blunt in the writeup about how much of Stipend's proposed scope is already covered.

Question 3 — who else is building this?
Find every existing crypto subscription or usage-billing product and record what it does, which chains, pricing, and whether it's non-custodial. Loop Crypto is a known starting point; also look for Superfluid, Sablier, Spritz, Radom, Helio and anything else you surface. For each, note specifically whether they support Base and whether they support usage-based billing or only fixed subscriptions.

Question 4 — what does a merchant need beyond the pull?
Using Stripe Billing's feature set as the reference, list what a real billing system does that a raw pull does not: failed-payment retry and dunning, proration on plan change, trials, invoices and receipts, refunds and credits, tax handling, revenue reporting, webhooks. Mark each as easy, hard, or blocked given the primitive's constraints from Question 1.

Question 5 — is the market reachable?
Estimate how many Base Accounts exist and find any published figure on Base Pay or Base App transaction volume. Identify what kind of merchant would plausibly want stablecoin subscriptions today — name real categories and, where you can, real companies.

Question 6 — regulatory shape.
If Stipend never custodies funds and payments settle merchant-direct, what is the regulatory exposure of operating the billing layer? Flag anything that looks like money transmission. Do not attempt a legal conclusion; collect the questions a lawyer would need to answer.

Kill criteria. Recommend no-go if either of these holds: spend permissions cannot express variable-amount pulls and an existing product already covers fixed subscriptions on Base competently; or Coinbase's own recurring-payments offering already spans most of Question 4's list.

Output: a single markdown report, one section per question, each opening with a direct one-line answer before the evidence. End with a go/no-go recommendation and, if go, the three narrowest wedges you'd suggest. Cite a source URL for every factual claim. Where you couldn't determine something, say so explicitly rather than inferring — I need to know which parts are unknown.