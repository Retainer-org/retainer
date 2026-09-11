import { H1, H2, P, UL, C, Cite, Callout, Pre, Table, Addr } from "@/components/docs/prose";

export default function ExactlyOnce() {
  return (
    <>
      <H1 lede="A charge must land at most once per billing period, even if the worker dies at the worst possible moment. Here is what guarantees it and how both branches were proven.">Exactly-once charging</H1>

      <H2 id="two-halves">Two halves of the guarantee</H2>
      <P>
        <b>At most one charge per period</b> is a database constraint: <C>UNIQUE (permission_id, period_start)</C>, where the period start is
        derived from the permission rather than chosen, so two workers cannot disagree about it.
        <Cite file="packages/db/migrations/001_init.sql" />
      </P>
      <P>
        <b>At most one on-chain spend per charge</b> is the hard part, because the dangerous window is after <C>eth_sendRawTransaction</C>
        returns and before the database learns it happened. The design that closes it:
      </P>
      <Pre title="apps/worker/src/charger.js — the ordering">{`sign locally  ->  PERSIST raw tx + hash + nonce  ->  COMMIT  ->  broadcast`}</Pre>
      <P>
        Because the transaction is signed locally, its hash is known before it is sent. That hash, the nonce, and the raw bytes are committed
        first. If the process dies afterwards — at any point — recovery has everything it needs to find out what happened, and can
        re-broadcast the <i>identical</i> bytes rather than signing again. Same nonce, same hash, so at most one can ever be mined.
        <Cite file="apps/worker/src/charger.js" line={133} />
      </P>

      <H2 id="nonces">Nonces</H2>
      <P>
        Nonces are allocated under a Postgres advisory lock inside the same transaction that persists the signed attempt, so a rolled-back
        attempt releases its nonce instead of burning it, and no two attempts can share one. On startup the stored counter is reconciled
        against the chain and the higher value wins. <Cite file="apps/worker/src/nonce.js" />
      </P>

      <H2 id="recovery">Recovery: three branches</H2>
      <P>On restart, every attempt still in <C>signed</C> or <C>broadcast</C> is resolved: <Cite file="apps/worker/src/recovery.js" line={14} /></P>
      <Table head={["Chain says", "Decision", "Why it is safe"]} rows={[
        ["Receipt exists for the hash", <>Record the outcome. <b>Never re-send.</b></>, "It landed. Sending again would be a second spend."],
        ["No receipt; the nonce is already consumed", <>Mark the attempt <C>superseded</C>; return the charge to retryable.</>, "Some other transaction took that nonce, so these bytes can never be mined. A fresh attempt on a fresh nonce is the only path."],
        ["No receipt; the nonce is still free", "Re-broadcast the identical raw transaction.", "Same hash, same nonce. If it was already in the mempool the node says so; either way only one can land."],
      ]} />

      <H2 id="proof">Proven, not argued</H2>
      <P>Both branches were forced deliberately on Base Sepolia with a fault-injection flag that exits the process hard. <Cite file="apps/worker/src/charger.js" label="RETAINER_CRASH_AFTER_BROADCAST / _BEFORE_BROADCAST" /></P>

      <P><b>A — killed after the send returned, before the row updated.</b> The attempt sat in the database as <C>signed</C> with no broadcast time, while the transaction was already on the wire. On restart, recovery found the receipt and recorded it. One spend; the audit trail for that charge has no <C>charge.broadcast</C> entry at all, because the process never lived long enough to write one.</P>
      <UL><li>the one transaction (charge #10, nonce 22): <Addr value="0x8e4ce873249fc57b52485086de99aa4a0b9e341a7165916282153bbf9f68e2df" tx /></li></UL>

      <P><b>B — killed after signing, before the send; nonce then taken by a competing transaction.</b> The attempt held nonce 24 durably. A separate transaction was landed on nonce 24. On restart, recovery took the superseded branch — it did <i>not</i> re-broadcast — and the charge succeeded on nonce 25. One spend.</P>
      <UL>
        <li>superseded attempt, never mined: <C>0x0a078798bcc3d5c5947a4c21687fed79a79332c1521b4b4900d62bfd2e9131a3</C></li>
        <li>competing transaction that consumed nonce 24: <Addr value="0x21cd8eb371c6557815715a4b69140c183f5b3981237d76c7724269f01622c32d" tx /></li>
        <li>the one spend (charge #11, nonce 25): <Addr value="0xe0ac2a1eed2bb2a5ea4c0a6ee418d4edb37c2320f488fa6b5eb2026aabb5244d" tx /></li>
      </UL>
      <P>
        For each permission, the on-chain count of <C>SpendPermissionUsed</C> events after the drill was exactly one.
        <Cite file="README.md" line={71} label="README — crash recovery" />
      </P>

      <Callout title="What this does not guarantee">
        It guarantees at most one spend per charge and at most one charge per period. It does not guarantee a charge <i>succeeds</i> —
        that is what the failure modes are for — and it assumes a single executor key. Running two workers against one executor is
        serialised by the advisory lock; running two executors is not a supported configuration.
      </Callout>
    </>
  );
}
