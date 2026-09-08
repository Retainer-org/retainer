import { H1, H2, P, OL, UL, C, Cite, Callout, Pre } from "@/components/docs/prose";

export default function ChargeLifecycle() {
  return (
    <>
      <H1 lede="From a signature to a row marked paid, and what has to be true at each step.">The charge lifecycle</H1>

      <OL>
        <li><b>The customer signs a permission</b> naming Retainer&apos;s router as spender and encoding <C>(executor, recipient)</C> in <C>extraData</C>. Off-chain; no gas.</li>
        <li><b>Retainer registers it</b> by submitting <C>approveWithSignature</C> from the executor. The executor pays. The permission row is stored with the exact struct and signature as the consent record. <Cite file="apps/web/app/api/permissions/route.js" /></li>
        <li><b>A charge is enqueued</b> for the current billing period. The period start is derived from the permission&apos;s <C>start</C> and <C>period</C>, never chosen, and <C>UNIQUE (permission_id, period_start)</C> makes it impossible to create two charges for one period. <Cite file="packages/db/migrations/001_init.sql" /></li>
        <li><b>The amount is resolved at charge time.</b> Fixed charges carry their amount; usage charges are enqueued at zero and summed from recorded usage when the worker runs. <Cite file="apps/worker/src/charger.js" label="resolveAmount" /></li>
        <li><b>Pre-flight classification</b> reads chain state — revoked, window, registered, remaining allowance, balance — and simulates the exact call. If any check fails the charge is classified and no transaction is sent. <Cite file="packages/chain/src/classify.js" /></li>
        <li><b>Sign, persist, then broadcast.</b> The transaction is signed locally, written to the database with its hash and nonce, committed, and only then sent. <Cite file="apps/worker/src/charger.js" line={107} /></li>
        <li><b>The router pulls and forwards atomically.</b> <C>spendAndRoute</C> calls the manager&apos;s <C>spend</C>, which transfers to the router, and the router forwards the full value to the recipient in the same transaction. <Cite file="contracts/src/SpendRouter.sol" line={114} /></li>
        <li><b>Reconciliation.</b> An indexer reads <C>SpendPermissionUsed</C> from the manager and <C>SpendRouted</C> from the router at three confirmations. A charge becomes <C>confirmed</C> only when both events are present for its transaction and the router paid the intended recipient. <Cite file="apps/worker/src/reconciler.js" line={5} /></li>
      </OL>

      <H2 id="paid">What &ldquo;paid&rdquo; means</H2>
      <P>
        A receipt says a transaction executed. It does not say where the money went. Retainer treats a charge as paid only when the
        two events say the customer&apos;s allowance was consumed <i>and</i> the router routed that value to the recipient on record;
        a mismatch is logged as <C>charge.recipient_mismatch</C> and the charge stays unconfirmed.
        <Cite file="apps/worker/src/reconciler.js" line={83} />
      </P>
      <P>
        The reconciler is the only writer of <C>confirmed</C>. The charger records <C>mined_success</C> on the attempt and stops.
        <Cite file="apps/worker/src/charger.js" label="awaitReceipt" />
      </P>

      <H2 id="who-pays">Who pays what</H2>
      <UL>
        <li>The customer pays nothing in gas — not for registration, not for charges.</li>
        <li>The executor pays gas for registration and for every charge attempt. An empty executor stops billing silently, so the worker checks its balance and refuses to start new charges below a threshold. <Cite file="apps/worker/src/gastank.js" /></li>
        <li>Measured on Base Sepolia: <C>spend()</C> 106,454–126,773 gas, and a routed charge 134,114–147,804 gas in the Phase 1 drills. At the Base fees observed, roughly $0.002–$0.011 per charge. <Cite file="phase0-addendum.md" line={111} /></li>
      </UL>

      <H2 id="run">Running it</H2>
      <Pre title="worker + cli">{`node --env-file=.env apps/worker/src/index.js                     # loop: recover, index, confirm, then one charge
node --env-file=.env apps/worker/src/index.js --once --charge 12  # one specific charge, once
node --env-file=.env apps/cli/src/index.js enqueue --permission 13 --amount 900000
node --env-file=.env apps/cli/src/index.js enqueue --permission 10 --usage
node --env-file=.env apps/cli/src/index.js ledger                 # confirmed charges -> tx hashes`}</Pre>

      <Callout title="The scheduler is Retainer's, not the contract's">
        Base&apos;s own documentation says a spend permission &ldquo;is not a subscription scheduler&rdquo; and tells integrators to run
        billing from a durable job queue with an idempotency key per period and to reconcile before marking an invoice paid. That
        sentence is the boundary Retainer is built on the far side of.
      </Callout>
    </>
  );
}
