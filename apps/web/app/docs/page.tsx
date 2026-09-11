import { H1, H2, P, UL, C, Cite, Callout, Pre } from "@/components/docs/prose";
import { Architecture } from "@/components/docs/architecture";

export default function WhatRetainerIs() {
  return (
    <>
      <H1 lede="Recurring and usage-based USDC billing on Base, where the biller never holds the money.">What Retainer is</H1>

      <P>
        Retainer is a charge engine. A customer signs one spend permission; Retainer registers it on-chain, charges against it
        on a schedule for whatever the period actually cost, routes each charge from the customer to the merchant&apos;s treasury
        in a single atomic transaction, and marks the charge paid only after the on-chain events confirm it.
        <Cite file="apps/worker/src/charger.js" />
      </P>

      <H2 id="system">The system, and its two fulfilment paths</H2>
      <P>
        An <b>expected payment</b> is the top-level object: an amount, a due date, and a state. It is satisfied one of two ways, and
        both are first-class. <b>Pull</b> draws on a spend permission through Retainer&apos;s router. <b>Watch</b> detects an incoming
        transfer the payer sent themselves and matches it to the obligation. The second exists because a Safe multisig
        <i>cannot</i> be the account of a spend permission, so DAO and treasury payers are reachable no other way.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={12} />
      </P>

      <Architecture caption="Both paths end at the merchant treasury, and Retainer holds the money on neither." />

      <P>
        The consequence worth noticing is that overdue detection has one path, not two: a pull whose charge failed terminally and a
        watch payment that never arrived both leave the same obligation unsatisfied past its due date, and both raise the same
        alert. <Cite file="apps/worker/src/sweep.js" line={11} />
      </P>

      <H2 id="problem">The problem it solves</H2>
      <P>
        Card rails give merchants recurring billing by letting a processor hold funds and reverse them. Onchain, the usual substitutes
        are worse in one of two ways: either the merchant is handed an unbounded ERC-20 allowance and asked to be trusted with it, or
        a third party sits in the flow and custodies money on the way through. Base spend permissions are a different primitive — a
        capped, self-resetting, revocable authorisation enforced by a contract — and Retainer is the billing layer that turns that
        primitive into something a merchant can run a business on: schedules, retries, failure classification, and reconciliation.
      </P>

      <H2 id="claims">What it does, and what backs each claim</H2>
      <UL>
        <li><b>Non-custodial by construction.</b> Funds move customer → router → merchant treasury in one transaction; if the forward fails, the whole charge reverts. A fuzz test asserts the router&apos;s balance is zero after every charge and fails the build otherwise. <Cite file="contracts/test/retainer/RouterCustodyInvariant.t.sol" line={24} /></li>
        <li><b>Built on Base spend permissions</b>, which are bounded per period, reset on-chain, and can be revoked by the customer at any time. None of that is enforced by Retainer. <Cite file="contracts/src/SpendPermissionManager.sol" line={38} /></li>
        <li><b>Variable and usage-based amounts</b>, computed at charge time up to the cap — not fixed when the charge is enqueued. <Cite file="apps/worker/src/charger.js" label="resolveAmount" /></li>
        <li><b>Exactly-once charging</b>, proven across both crash-recovery branches on Base Sepolia. <Cite file="apps/worker/src/recovery.js" line={9} /></li>
        <li><b>Six failure modes classified from chain state</b> before any gas is spent, each with its own disposition. <Cite file="packages/chain/src/classify.js" line={25} /></li>
        <li><b>Paid means reconciled</b> — only the reconciler writes <C>confirmed</C>, and only after both on-chain events are indexed. <Cite file="apps/worker/src/reconciler.js" line={76} /></li>
        <li><b>About half a cent of gas per charge</b>, measured on real transactions. <Cite file="phase0-addendum.md" line={111} /></li>
      </UL>

      <H2 id="shape">The integration, in three lines</H2>
      <Pre title="merchant/billing.ts">{`// 1. The customer signs once. Retainer registers it on-chain and pays the gas.
const permission = await requestSpendPermission({
  account, spender: RETAINER_ROUTER, token: USDC,
  allowance: 20_000_000n,        // 20 USDC per period — a ceiling, not a price
  periodInDays: 30,              // resets on-chain; nothing carries over
  extraData: encodeExtraData(executor, merchantTreasury),
  provider,
});

// 2. Charge whatever this period actually cost, up to the cap, when it's due.
await enqueueCharge({ permission, amount: usageThisPeriod });

// 3. "Paid" means the on-chain events say so — never that a transaction was sent.`}</Pre>
      <P>
        The first call is Coinbase&apos;s Base Account SDK; the second is Retainer&apos;s queue. A customer&apos;s billing link — <C>/pay/&lt;token&gt;</C>, where
        the merchant&apos;s exact terms come from the link — and the API route behind it are the real implementation of step 1. <Cite file="apps/web/app/api/permissions/route.js" />
      </P>

      <Callout kind="limit" title="Where it runs">
        Base Sepolia only, chain 84532. There is no mainnet deployment and no production claim. The limitations page lists what else is
        not true yet.
      </Callout>
    </>
  );
}
