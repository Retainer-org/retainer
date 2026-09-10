import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";

export default function ReviewQueue() {
  return (
    <>
      <H1 lede="Where the matcher's refusal to guess is paid for, and where the system learns so it does not have to refuse the same thing twice.">
        The review queue
      </H1>

      <P>
        Six of the matcher&apos;s seven outcomes end in <C>needs_review</C>. A queue that only ever grew would make that design
        indefensible, so the queue is built around one action that shrinks it permanently: linking a sending address to a customer.
        Everything else resolves one transfer; that one changes what happens to every future transfer from that address.
        <Cite file="apps/worker/src/matcher.js" line={204} />
      </P>

      <H2 id="evidence">It shows the reasoning, not just the verdict</H2>
      <P>
        A queue item that says &ldquo;needs review&rdquo; and nothing else hands the merchant the whole problem back. Each item
        instead carries the reason in plain English, the candidates the matcher weighed, and the signed difference against each —
        &ldquo;short by 0.40&rdquo;, &ldquo;over by 0.30&rdquo;, &ldquo;exact&rdquo;.
        <Cite file="apps/web/components/dashboard/review-card.tsx" line={17} />
      </P>
      <P>
        This is the same principle as classifying failures before spending gas: the product&apos;s judgement should be legible. A
        merchant should be able to see exactly what evidence existed and why it was not enough, rather than being told a verdict
        and left to reconstruct it.
      </P>

      <H2 id="actions">The five actions</H2>
      <P>
        These are the only mutations anywhere in the dashboard. Every other page is read-only, and all five route through
        <C>resolveReview</C> — the same code path the CLI uses — so the interface cannot perform a resolution the engine would
        refuse. <Cite file="apps/web/app/dashboard/review/actions.ts" line={10} />
      </P>

      <Table head={["Action", "What it does", "Effect on the ledger"]} rows={[
        ["Apply in full", "Attributes the whole transfer to one obligation.", <>Obligation becomes <C key="a">paid</C>.</>],
        ["Apply as partial", "Attributes less than the transfer's value.", <>Obligation becomes <C key="b">partially_paid</C> and stays outstanding.</>],
        ["Apply with surplus", "Attributes more than the obligation still owed.", <>Obligation is settled; the excess is recorded as <C key="c">surplus</C> rather than inflating it.</>],
        ["Not a payment", "Records the human judgement that this is not a payment.", <>Transfer becomes <C key="d">ignored</C>. It is kept on record, never deleted. <Cite key="d1" file="apps/worker/src/matcher.js" line={242} /></>],
        ["Link sender to customer", "Teaches the matcher that this address belongs to this customer.", <>Writes a <C key="e">customer_addresses</C> row; optionally applies in the same transaction. <Cite key="e1" file="apps/worker/src/matcher.js" line={232} /></>],
      ]} />

      <Callout kind="note" title="A human resolution is always labelled as one">
        The interface has no way to write <C>auto_matched</C>. Whatever a person does in review is recorded with confidence
        <C>manual</C>, so the audit trail permanently distinguishes what the matcher decided from what a person decided.
        <Cite file="apps/worker/src/matcher.js" line={249} />
      </Callout>

      <H2 id="learning">The learning loop</H2>
      <P>
        Linking is the only action with a future. Because <C>(chain_id, address)</C> is unique, an address belongs to at most one
        customer, so linking is an unambiguous statement rather than a hint. The next transfer from that address for an exact
        outstanding amount satisfies <C>|X| == 1</C> and matches on its own.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={39} />
      </P>
      <Pre title="the loop, in one sequence">{`transfer from 0xcD55…AF2D, 65.000000 USDC
  -> unknown_sender             (amount matches; nobody owns that address)
  -> human links it to customer #7, applying at the same time
  -> obligation paid

next transfer from 0xcD55…AF2D for an exact outstanding amount
  -> exact_known_sender         auto-matched. the review does not recur.`}</Pre>
      <P>
        That last step is asserted, not asserted-and-hoped: the drill links a sender, then re-classifies an identical fresh transfer
        and requires the verdict to be <C>auto_matched / exact_known_sender</C>.
        <Cite file="scripts/phase2-dashboard-drills.mjs" line={228} />
      </P>
      <P>
        The interface reflects this rather than hiding it. Linking is presented in its own framed block as the action that teaches
        the matcher, not as one button among five.
        <Cite file="apps/web/components/dashboard/review-card.tsx" line={136} />
      </P>

      <H2 id="gate">Why the actions are disabled on the public deployment</H2>
      <P>
        The dashboard has no authentication. On a public URL that is fine for reading testnet data whose addresses are already
        public, and not fine for writing: anyone who could open the page could otherwise alter the records they were looking at. So
        the write path is gated on an environment flag. <Cite file="apps/worker/src/matcher.js" line={216} />
      </P>
      <P>
        Unset means denied, which is the important direction — a new or misconfigured deployment is read-only by accident rather
        than writable by accident. <Cite file="apps/worker/src/matcher.js" line={224} /> The gate sits in <C>resolveReview</C>
        itself rather than in the interface, so disabling the buttons is a courtesy and not the control: posting the server actions
        directly is refused too.
      </P>
      <UL>
        <li>Locally, with the flag set, all five actions work and the CLI is unaffected.</li>
        <li>On the deployment the page states plainly that actions are disabled, and why. <Cite file="apps/web/app/dashboard/review/page.tsx" line={24} /></li>
        <li>Authentication is listed as not built, with the exposure bounded: no path in the review actions moves money. See <Link href="/docs/limitations" className="text-brand-primary hover:underline">current limitations</Link>.</li>
      </UL>
    </>
  );
}
