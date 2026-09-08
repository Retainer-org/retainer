import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";

export default function FailureModes() {
  return (
    <>
      <H1 lede="Every failed charge is classified from chain state before any gas is spent, and each class has its own disposition. This is the product's core idea, not an error appendix.">The six failure modes</H1>

      <P>
        A card decline is one thing that happened, retried by one policy. A spend-permission charge can fail for six distinguishable reasons,
        and they call for different responses: some can never succeed again, some can only succeed at a known future instant, and one is
        worth retrying soon. Collapsing them into &ldquo;failed&rdquo; throws away exactly the information a merchant needs. Retainer keeps
        them apart from the first line of the schema. <Cite file="packages/db/migrations/001_init.sql" label="failure_mode enum" />
      </P>

      <H2 id="order">Classification order</H2>
      <P>
        The classifier reads chain state in a fixed order and returns the first condition that holds. The order matters: a revoked
        permission is revoked whatever else is true of it; an expired one is expired even if it was never registered.
        <Cite file="packages/chain/src/classify.js" line={25} />
      </P>

      <Table head={["#", "Mode", "What it means", "How it is detected", "Disposition", "Why that disposition"]} rows={[
        ["1", <C>REVOKED</C>, "The customer (or the spender) revoked the permission on-chain.", <><C>isRevoked()</C> is true. <Cite file="packages/chain/src/classify.js" line={25} /></>, <b>Terminal</b>, "Revocation is permanent in the contract. No retry can succeed; the merchant needs a new signature."],
        ["2", <C>EXPIRED</C>, <>The permission&apos;s <C>end</C> has passed.</>, <>now ≥ <C>end</C>. <Cite file="packages/chain/src/classify.js" line={30} /></>, <b>Terminal</b>, "The window is closed forever. Same remedy: a new permission."],
        ["3", <C>NOT_STARTED</C>, <>The permission&apos;s <C>start</C> is still in the future (a trial, or a future-dated plan).</>, <>now &lt; <C>start</C>. <Cite file="packages/chain/src/classify.js" line={33} /></>, <><b>Deferred</b> to <C>start</C></>, "It will succeed at a known instant and cannot succeed before it. Retrying earlier is waste."],
        ["4", <C>NOT_APPROVED</C>, "Signed, but never registered on-chain.", <><C>isApproved()</C> is false. <Cite file="packages/chain/src/classify.js" line={43} /></>, <b>Deferred</b>, <>The cure is submitting <C>approveWithSignature</C>, not retrying the charge. Retainer can do that gaslessly for the customer.</>],
        ["5", <C>ALLOWANCE_EXHAUSTED</C>, "This period's cap is already used up, or the amount exceeds what remains.", <><C>allowance − getCurrentPeriod().spend</C> &lt; amount. <Cite file="packages/chain/src/classify.js" line={53} /></>, <><b>Deferred</b> to the period end</>, "The allowance resets only at the boundary and unused allowance does not carry forward, so the next possible success is exactly then."],
        ["6", <C>INSUFFICIENT_BALANCE</C>, "The cap allows it; the customer's account cannot fund it.", <>USDC <C>balanceOf(account)</C> &lt; amount. <Cite file="packages/chain/src/classify.js" line={64} /></>, <><b>Retrying</b> with backoff</>, "The customer may top up at any moment. A reverted charge consumes no allowance, so retrying is safe against the cap; it is capped by gas instead."],
      ]} />

      <H2 id="dispositions">The dispositions, precisely</H2>
      <P>From <C>dispositionFor</C> in the charger: <Cite file="apps/worker/src/charger.js" line={4} /></P>
      <Pre title="apps/worker/src/charger.js — dispositionFor, abridged">{`REVOKED, EXPIRED            -> failed_terminal   (no next attempt)
INSUFFICIENT_BALANCE        -> failed_retryable  next = now + min(3600, 30 * 2^(attempts-1)) seconds
                               after 8 attempts  -> failed_terminal
ALLOWANCE_EXHAUSTED         -> failed_deferred   next = current period's end
NOT_STARTED                 -> failed_deferred   next = permission.start
NOT_APPROVED                -> failed_deferred   next = now + 5 minutes (pending registration)
UNKNOWN                     -> failed_retryable  next = now + 5 minutes`}</Pre>
      <P>
        Three of the six carry a <i>time</i>, and it is shown on the dashboard because it is the whole content of the deferred
        promise: not &ldquo;we&apos;ll try again&rdquo; but &ldquo;we&apos;ll try at 2026-09-08T21:31:09Z, because that is when it can work.&rdquo;
      </P>

      <H2 id="race">When the pre-flight is wrong</H2>
      <P>
        State can change between simulation and inclusion — a revocation mined in the same block, a transfer out of the account. Then the
        transaction reverts on-chain and the classifier falls back to decoding the revert: the manager&apos;s custom error selectors are pinned
        by a Foundry test so an upstream change cannot silently break decoding, and Circle&apos;s USDC — which reverts with a plain string, not
        a custom error — is why insufficient balance must be caught by state rather than by selector.
        <Cite file="contracts/test/retainer/ErrorSelectors.t.sol" /> <Cite file="packages/chain/src/errors.js" />
      </P>

      <H2 id="evidence">Each mode, triggered deliberately</H2>
      <P>
        In the Phase 1 drills every mode was forced on Base Sepolia and classified without a transaction being sent — six failures, zero gas.
        The dashboard&apos;s Failures view shows those six rows grouped by disposition, with the classifier&apos;s recorded detail
        (<C>want=2000000 remaining=1000000 periodEnd=…</C>) and the next-attempt time where one exists.
      </P>
      <UL>
        <li>Terminal: charges #5 (<C>EXPIRED</C>) and #6 (<C>REVOKED</C>)</li>
        <li>Deferred: #2 (<C>ALLOWANCE_EXHAUSTED</C>), #4 (<C>NOT_STARTED</C>), #7 (<C>NOT_APPROVED</C>)</li>
        <li>Retrying: #3 (<C>INSUFFICIENT_BALANCE</C>, four attempts recorded)</li>
      </UL>

      <Callout kind="warn" title="What is deliberately not built">
        Nothing here re-asks the customer for anything. A terminal failure is recorded, not escalated; a cap that is too small is reported,
        not automatically renegotiated. Re-authorisation flows and usage forecasting are the next product decisions, and they wait on
        merchant conversations that have not happened.
      </Callout>
    </>
  );
}
