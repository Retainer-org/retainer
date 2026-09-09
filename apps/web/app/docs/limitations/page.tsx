import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table } from "@/components/docs/prose";

export default function Limitations() {
  return (
    <>
      <H1 lede="Stated plainly. If a thing is not on this page, it is either true or listed elsewhere as proven — not quietly assumed.">Current limitations</H1>

      <Table head={["Limitation", "Detail", "Status"]} rows={[
        ["Base Sepolia only", "Chain 84532. Every address and transaction in these docs is testnet. There is no mainnet deployment, no production claim, and the test keys are disposable.", "By decision"],
        ["Hosted consent blocked upstream", <>A newly created Base Account cannot sign a spend permission on Base Sepolia: Coinbase&apos;s hosted screen refuses with &ldquo;This chain is not supported.&rdquo; See below.</>, <Link href="https://github.com/base/account-sdk/issues/363" target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">base/account-sdk#363</Link>],
        ["No fee mechanism in the router", "The router forwards the full value to one recipient. Retainer cannot take a percentage without becoming custodial. Revenue must be a flat merchant fee, outside the flow.", "Structural"],
        ["No auth on the dashboard", <>/dashboard is public and has <b>no authentication of any kind</b>. Five review actions can now write &mdash; applying a transfer to an obligation, marking one not-a-payment, and linking a sender to a customer &mdash; so anyone who can reach the URL can alter matching records. No money can move: the actions only attribute transfers that already happened, and cannot charge, revoke or transfer. Acceptable only because this is testnet data whose addresses are already public. Not acceptable for a real merchant, and auth must land before any deployment that is not this one.</>, "Not built"],
        ["No invoices, plans, customers, tax, proration or refunds", "Retainer is a charge engine. None of these objects exist. Refunds in particular cannot be executed by a non-custodial layer, only instructed.", "Not built"],
        ["No re-authorisation or usage forecasting", "A cap that is too small is reported, not renegotiated. These are the next product decisions and depend on merchant conversations that have not happened.", "Not built"],
        ["Single executor", "One executor key per deployment. Multiple workers are serialised by an advisory lock; multiple executors are not supported.", "By design, for now"],
        ["Reorgs are detectable, not handled", <>Incoming transfers are indexed at three confirmations and store their <C>block_hash</C>, so a reorg beneath an indexed transfer can be <i>detected</i>. Nothing automatically unwinds a match whose transfer no longer exists — a human would have to reverse it.</>, "Stated, not built"],
        ["Watch matching never guesses", <>Only an exact remaining amount from a sender already linked to a customer is matched automatically. Everything else — ambiguous ties, amount mismatches, unknown senders — waits in a review queue. This is deliberate, but it means a merchant with many unlinked senders does manual work until the links are learned.</>, "By design"],
        ["Usage metering is storage only", <>A <C>usage_records</C> table and a sum at charge time. No rating, tiers or aggregation windows.</>, "By decision"],
      ]} />

      <H2 id="363">The hosted-consent block, precisely</H2>
      <P>
        Coinbase&apos;s <C>keys.coinbase.com</C> signing screen rejects Base Sepolia for newly created Base Accounts with the message
        <i>&ldquo;This chain is not supported. Base Sepolia is not supported. Please try a different chain.&rdquo;</i> The message is misleading:
        Base Sepolia is in the popup&apos;s supported-chains map and supplies the display name in that very error. The operative check is
        <C>isTestnet</C> inside the wallet-upgrade path — testnet delegation provisioning for EIP-7702 accounts, wearing chain-support copy.
        <Cite file="README.md" line={101} />
      </P>
      <Table head={["Account type", "On-chain code", "Base Sepolia consent"]} rows={[
        ["ERC-4337 (factory-deployed contract)", <C>0x363d3d37…</C>, "works — every charge in these docs was made this way"],
        ["EIP-7702 (delegated EOA)", <C>0xef0100…</C>, "refused"],
      ]} />
      <UL>
        <li>Open since 2026-07-10. No maintainer response as of 2026-09-09. A documentation-only PR (#390) has been open and unmerged since 2026-08-21.</li>
        <li>It also blocks Coinbase&apos;s own documented <C>pay({"{ testnet: true }"})</C> flow, so it is not specific to Retainer.</li>
        <li><b>Unknown:</b> whether Base Accounts created before the 7702 provisioning change still pass. The issue thread reports that they do; Retainer has not been able to test it because no such account was available.</li>
        <li><b>Unknown:</b> whether or when Coinbase will change this. No statement has been made.</li>
      </UL>
      <P>
        Retainer deliberately did not route around it. Going to mainnet to dodge a testnet bug would have meant a permanent deployment and a
        real-money key set months ahead of need.
      </P>

      <H2 id="base-app">Distribution inside the Base App</H2>
      <P>
        Base&apos;s documentation for spend permissions carries the note that &ldquo;Spend Permissions for Base App Apps are coming soon and
        will be supported in a future update.&rdquo; That is Coinbase&apos;s statement, not Retainer&apos;s. Today the primitive is reachable only from
        external web apps using the Base Account SDK. <b>When, or whether, it reaches Base App mini-apps is unknown.</b>
      </P>

      <H2 id="reorgs">Reorgs</H2>
      <P>
        Watch mode indexes incoming transfers at three confirmations, the same depth the charge reconciler uses, and stores each
        transfer&apos;s <C>block_hash</C> alongside its block number. That makes a reorg beneath an already-indexed transfer
        <i>detectable</i>: a later scan finding a different hash at the same height means the transfer, and any payment matched from
        it, may no longer exist on chain. <Cite file="apps/worker/src/watcher.js" label="detectReorgs" />
      </P>
      <P>
        <b>Detection is not handling.</b> Nothing automatically unwinds a match whose underlying transfer has vanished, and nothing
        re-opens an expected payment that was settled by one. On Base at three confirmations this is unlikely rather than impossible,
        and the honest position is to say so rather than to imply a guarantee the code does not provide.
      </P>

      <H2 id="verification">What has and has not been verified</H2>
      <UL>
        <li>Verified: everything on the evidence section of the landing page, the six failure modes, both crash-recovery branches, the custody invariant in tests and on live balances.</li>
        <li>Not verified: behaviour under sustained load, behaviour with many concurrent permissions, Base fee spikes beyond the 30-day window sampled, or any mainnet condition.</li>
        <li>Not verified: the real-account browser path end to end — blocked as above. The scripted ERC-4337 path proves the state machine; the real one would prove the integration.</li>
      </UL>

      <Callout title="Reporting standard">
        Where these docs say a number, it was read from the chain or the database before being written. Where they say &ldquo;reportedly,&rdquo;
        the source is someone else&apos;s report. Where they say unknown, nobody has checked.
      </Callout>
    </>
  );
}
