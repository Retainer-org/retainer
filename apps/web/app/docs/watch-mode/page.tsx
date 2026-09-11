import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";

export default function WatchMode() {
  return (
    <>
      <H1 lede="Some payers cannot sign a spend permission at all — not by policy, but because the contract that enforces permissions cannot call their account. Watch mode is how those payers are billed.">
        Watch mode, and why it exists
      </H1>

      <P>
        Pull is the better mechanism where it works: the merchant does not have to chase anyone, and the cap is enforced on-chain.
        But it has a hard boundary, and the boundary is not a matter of taste or of Coinbase&apos;s product decisions. It is a cast in
        the contract.
      </P>

      <H2 id="safe">A Safe multisig can never be the account of a spend permission</H2>
      <P>
        <C>SpendPermissionManager</C> moves a customer&apos;s funds by calling their account. That call is not made through an
        interface the account may or may not satisfy — the manager casts the address to <C>CoinbaseSmartWallet</C> and calls
        <C>execute(target, value, data)</C> on it. <Cite file="contracts/src/SpendPermissionManager.sol" line={765} />
      </P>
      <Pre title="contracts/src/SpendPermissionManager.sol — _execute">{`function _execute(address account, address target, uint256 value, bytes memory data) internal virtual {
    CoinbaseSmartWallet(payable(account)).execute({target: target, value: value, data: data});
}`}</Pre>
      <P>
        A Gnosis Safe does not implement <C>execute(address,uint256,bytes)</C>. It exposes <C>execTransaction</C>, and for module
        calls <C>execTransactionFromModule</C>, neither of which matches that selector. So the call does not merely fail a
        permission check — it reverts for want of a function. The contract&apos;s own summary line says as much before any of the
        logic does: it allows spending &ldquo;from a <C>CoinbaseSmartWallet</C>&rdquo;.
        <Cite file="contracts/src/SpendPermissionManager.sol" line={19} />
      </P>

      <Callout kind="warn" title="Stated at the right strength">
        This is established by reading the deployed manager&apos;s source, which Retainer vendors verbatim at a pinned upstream commit
        and re-verifies by hash. <Cite file="contracts/src/PROVENANCE.md" line={16} /> It has <b>not</b> been demonstrated by
        submitting a Safe-account permission on-chain and observing the revert. The claim is a reading of the code, and is graded
        that way deliberately.
      </Callout>

      <P>
        There is one escape hatch, and it is worth naming precisely because it changes what the claim means. <C>_execute</C> is
        <C>virtual</C>, and its own comment invites overriding it for other account implementations.
        <Cite file="contracts/src/SpendPermissionManager.sol" line={758} /> A <i>different deployment</i> of the manager could
        therefore support Safes. The canonical instance that Base Account signs against does not override it, so for the address
        Retainer transacts with, the boundary holds. Whether Coinbase intends to ship such an override is unknown, and nothing
        here assumes either way.
      </P>

      <H2 id="consequence">What follows from that</H2>
      <P>
        DAOs, funds and company treasuries are exactly the payers who hold money in a multisig, and they are a large share of who
        pays a recurring invoice in crypto. If pull were the only mechanism, Retainer would be unable to bill them at all. Watch
        mode is not a convenience feature or a fallback for the impatient; it is the only path to that segment.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={12} />
      </P>

      <H2 id="how">How watching works</H2>
      <P>
        A transfer becomes a candidate for matching only after it is confirmed and indexed. Nothing is matched from a pending
        transaction, and nothing is matched from the mempool.
      </P>

      <Table head={["Step", "What happens", "Where"]} rows={[
        ["1", <>USDC <C>Transfer</C> logs addressed to the merchant treasury are read forward from a cursor.</>, <Cite key="a" file="apps/worker/src/watcher.js" line={40} />],
        ["2", <>Only blocks at least three confirmations behind the head are indexed.</>, <Cite key="b" file="apps/worker/src/watcher.js" line={49} />],
        ["3", <>Each transfer is stored with its <C>block_hash</C>, unique on <C>(tx_hash, log_index)</C>, in state <C>pending</C>.</>, <Cite key="c" file="packages/db/migrations/003_expected_payments.sql" line={158} />],
        ["4", <>The matcher classifies each pending transfer and either attributes it or sends it to review.</>, <Link key="d" href="/docs/matching" className="text-brand-primary hover:underline">matching</Link>],
      ]} />

      <P>
        Watch mode keeps its own cursor rather than sharing the charge engine&apos;s. The two read different logs at different depths
        and must be able to fall behind independently; one cursor would couple them for no benefit.
        <Cite file="apps/worker/src/watcher.js" line={21} />
      </P>

      <H2 id="internal">Our own router is a state, not a filter</H2>
      <P>
        Every historic incoming transfer to the treasury came from Retainer&apos;s own router — because every one of them was a pull
        that the reconciler had already accounted for. Matching those again would double-count each of them. The obvious fix is to
        skip transfers whose sender is the router; the fix actually taken is to <i>classify</i> them, as
        <C>internal / router_fulfilment</C>. <Cite file="apps/worker/src/matcher.js" line={67} />
      </P>
      <P>
        The difference matters. A filter is invisible: nothing records that a transfer was seen and dismissed, so a bug in the
        filter looks exactly like a transfer that never arrived. A state is on the row, countable and auditable, and the
        dashboard can show that six transfers were recognised as our own rather than silently absent.
      </P>

      <H2 id="reorgs">The reorg gap, stated rather than papered over</H2>
      <P>
        Three confirmations makes a reorg beneath an indexed transfer unlikely, not impossible. Storing <C>block_hash</C> means a
        reorg can be <i>detected</i> — the indexed hash stops matching the canonical block at that height.
        <Cite file="apps/worker/src/watcher.js" line={92} />
      </P>
      <P>
        Nothing automatically unwinds a match whose transfer no longer exists. A human would have to reverse it. That is a real
        gap, it is listed as one, and it is not described as handled.
        <Cite file="apps/web/app/docs/limitations/page.tsx" line={25} />
        See <Link href="/docs/limitations#reorgs" className="text-brand-primary hover:underline">current limitations</Link>.
      </P>
    </>
  );
}
