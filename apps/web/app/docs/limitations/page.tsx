import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table } from "@/components/docs/prose";

export default function Limitations() {
  return (
    <>
      <H1 lede="Stated plainly. If a thing is not on this page, it is either true or listed elsewhere as proven — not quietly assumed.">Current limitations</H1>

      <Table head={["Limitation", "Detail", "Status"]} rows={[
        ["Base Sepolia only", "Chain 84532. Every address and transaction in these docs is testnet. There is no mainnet deployment, no production claim, and the test keys are disposable.", "By decision"],
        ["Base Account consent blocked upstream", <>A newly created Base Account cannot sign a spend permission on Base Sepolia: Coinbase&apos;s hosted screen refuses with &ldquo;This chain is not supported.&rdquo; See below. <b>It no longer blocks testnet.</b> A browser wallet signs through a smart account it owns, which never reaches that screen — proven with MetaMask, permission #18 <Cite tx="0xa647cbb0f762f9ea7d4fe7eaef576021f4564840f5d4c0b9cd27e6dc142bf34b" />. See <Link href="/docs/wallets" className="text-brand-primary hover:underline">signing with any wallet</Link>.</>, <Link href="https://github.com/base/account-sdk/issues/363" target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">base/account-sdk#363</Link>],
        ["No fee mechanism in the router", "The router forwards the full value to one recipient. Retainer cannot take a percentage without becoming custodial. Revenue must be a flat merchant fee, outside the flow.", "Structural"],
        ["No auth on the dashboard", <>/dashboard is public, has <b>no authentication</b>, and shows every merchant record to anyone who reaches it. Its five review actions are the only writes, and they are switched off unless <C>RETAINER_ENABLE_REVIEW_WRITES=true</C>, which the public deployment does not set — so there it is read-only. Merchant sign-in, with every query scoped to the signed-in merchant, is designed and not built.</>, "Not built"],
        ["One EIP-7702 delegate is trusted, by decision", <>MetaMask converts customer accounts to EIP-7702 accounts by itself, inside the revoke <Cite tx="0x2b19810bc90818b1a1baf0f6690aed03b1c3138cc0e218961b6f9d2b409b7a55" />, which would otherwise stop a customer who cancelled from ever registering again. So, for registration only, exactly one delegate is accepted as an owner: MetaMask&apos;s <C>EIP7702StatelessDeleGator</C>, whose verified source checks signatures with plain ECDSA against the account&apos;s own address — the same property as a plain account. It is hardcoded, and pinned to the hash of the code that was reviewed; if that code ever differs, the owner is refused. Every other delegate, and every other contract account, is still refused for registration. Sign-in does not consult delegates at all. See <Link href="/docs/wallets#metamask-upgrades" className="text-brand-primary hover:underline">signing with any wallet</Link>.</>, "Deliberate, scoped exception"],
        ["Merchant names on links are not verified", <>A billing link names its merchant, and the pay page shows that name — always beside the address the money goes to, with plain wording that the name is what the link calls the merchant. Today every link is created by the operator, so the name is only as trustworthy as the operator. <b>Stage 2 requirement:</b> once merchants create their own links, an unverified name is an attack surface — anyone could name a link after a company a customer trusts. Merchant links must carry an identity bound to the signed-in merchant wallet, and the page must not present a name as more than what it is.</>, "Stage 2 requirement"],
        ["A link schedules only the first charge", "A billing link's plan decides when the first charge falls due — at signup, at the end of the first period, or not at all — and the customer sees that rule in the terms before signing. Later charges are still created by the operator; recurring schedules belong to the merchant surface.", "Partly built"],
        ["Signing in is not privacy", <>A customer&apos;s permissions and charges are served only to a browser that has signed in as that wallet. That stops Retainer handing one customer&apos;s records to another. It does not hide them: they are on a public chain, and anyone can look an address up. See <Link href="/docs/wallets#signing-in" className="text-brand-primary hover:underline">signing in</Link>.</>, "By nature"],
        ["A contract account with no key cannot sign in", <>Signing in proves one thing — that the person holds the wallet&apos;s key — and checks it by plain signature recovery. Plain accounts and every EIP-7702-upgraded account can sign in, whatever their delegate. A true contract account, such as a Safe or a smart wallet used directly, has no key and cannot. It loses nothing by it: such an account cannot register a permission either, and pays by plain transfer instead, which the matcher attributes. See <Link href="/docs/wallets#signing-in" className="text-brand-primary hover:underline">signing in</Link>.</>, "By design"],
        ["Wallet-owned accounts start empty", "On the wallet-owned path, charges draw from a smart account that is a different address from the customer's wallet, and it starts with no funds. The sign page makes funding an explicit step. A gasless top-up by signature (EIP-3009) has been simulated, not built.", "Known friction"],
        ["Reads are not pinned to a block in production", "The public RPC can answer from a node a block behind the one that returned a receipt. The drills pin every post-transaction read to the receipt's block; the server's owner-code check and the dashboard read latest. A keyed RPC endpoint would remove most of it.", "Stated, not built"],
        ["Rate limits key on an unsalted IP hash", "Registration limits use sha256 of the client IP, never the IP itself. The IPv4 space is small enough to reverse, so this is a limiter, not a privacy property.", "Stated"],
        ["The indexer stores other parties' events", "SpendPermissionUsed is indexed for every spender on the shared manager, not only ours. Confirmation matches on our own transaction hashes, so it is noise in the table, not an error.", "Known"],
        ["No invoices, plans, customers, tax, proration or refunds", "Retainer is a charge engine. None of these objects exist. Refunds in particular cannot be executed by a non-custodial layer, only instructed.", "Not built"],
        ["No re-authorisation or usage forecasting", "A cap that is too small is reported, not renegotiated. These are the next product decisions and depend on merchant conversations that have not happened.", "Not built"],
        ["Single executor, single worker", "One executor key per deployment, and one worker at a time: a worker runs only while it holds a lease, and every transaction that creates or retires a charge attempt re-checks it. Multiple executors are not supported.", "By design, for now"],
        ["Reorgs are detectable, not handled", <>Incoming transfers are indexed at three confirmations and store their <C>block_hash</C>, so a reorg beneath an indexed transfer can be <i>detected</i>. Nothing automatically unwinds a match whose transfer no longer exists — a human would have to reverse it.</>, "Stated, not built"],
        ["Watch matching never guesses", <>Only an exact remaining amount from a sender already linked to a customer is matched automatically. Everything else — ambiguous ties, amount mismatches, unknown senders — waits in a review queue. This is deliberate, but it means a merchant with many unlinked senders does manual work until the links are learned.</>, "By design"],
        ["Usage metering is storage only", <>A <C>usage_records</C> table and a sum at charge time. No rating, tiers or aggregation windows.</>, "By decision"],
      ]} />

      <H2 id="363">The hosted-consent block, precisely</H2>
      <P>
        This affects the Base Account path only. On testnet the working route is a browser wallet owning a smart account — see{" "}
        <Link href="/docs/wallets" className="text-brand-primary hover:underline">signing with any wallet</Link>.
      </P>
      <P>
        Coinbase&apos;s <C>keys.coinbase.com</C> signing screen rejects Base Sepolia for newly created Base Accounts with the message
        <i>&ldquo;This chain is not supported. Base Sepolia is not supported. Please try a different chain.&rdquo;</i> The message is misleading:
        Base Sepolia is in the popup&apos;s supported-chains map and supplies the display name in that very error. The operative check is
        <C>isTestnet</C> inside the wallet-upgrade path — testnet delegation provisioning for EIP-7702 accounts, wearing chain-support copy.
        <Cite file="README.md" line={102} />
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
