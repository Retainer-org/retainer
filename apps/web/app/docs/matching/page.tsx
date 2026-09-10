import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";

export default function Matching() {
  return (
    <>
      <H1 lede="An incoming transfer either lands on exactly one obligation for reasons that leave no room for judgement, or it goes to a human. There is no middle setting, and that is a design decision rather than an unfinished one.">
        The matching engine
      </H1>

      <P>
        Watch mode raises a question pull never has to answer: <i>which obligation does this money pay?</i> A bank transfer arrives
        with a sender and an amount, and nothing else. The engine&apos;s whole job is to decide when those two facts are enough.
      </P>

      <Callout kind="note" title="The governing rule">
        Never auto-match ambiguously. A wrong automatic match is worse than no match at all, because it silently marks a customer
        paid who has not paid — and unlike a missing match, nobody goes looking for it.
        <Cite file="apps/worker/src/matcher.js" line={8} />
      </Callout>

      <H2 id="no-score">Why there is no confidence score</H2>
      <P>
        The conventional design gives each candidate a score and matches above a threshold. Retainer deliberately does not, and the
        reasoning is short: a score invites a threshold, and a threshold is precisely how ambiguous auto-matches happen. Whatever
        number you pick, some pair of obligations eventually sits either side of it for reasons no one can explain to the merchant
        afterwards. <Cite file="apps/worker/src/matcher.js" line={11} />
      </P>
      <P>
        Instead there are two booleans per candidate, and no arithmetic on them:
      </P>
      <UL>
        <li><b>senderKnown</b> — the transfer&apos;s sender is a linked address of that obligation&apos;s customer. <Cite file="apps/worker/src/matcher.js" line={72} /></li>
        <li><b>amountExact</b> — the transfer equals the obligation&apos;s <i>remaining</i> amount, so an exact top-up of a partially paid obligation still counts. <Cite file="apps/worker/src/matcher.js" line={78} /></li>
      </UL>
      <Pre title="apps/worker/src/matcher.js — the whole decision">{`S = candidates whose customer owns the sending address
A = candidates whose remaining amount equals the transfer exactly
X = S n A

|X| == 1  ->  auto-match. the only path that writes auto_matched.
everything else -> a human looks at it, with the evidence.`}</Pre>
      <P>
        <C>|X| == 1</C> is the sole writer of <C>auto_matched</C>, mirroring the rule elsewhere in the system that the reconciler is
        the sole writer of <C>confirmed</C>. Both exist so that a state which means &ldquo;we are sure&rdquo; has exactly one
        author. <Cite file="apps/worker/src/matcher.js" line={19} />
      </P>

      <H2 id="outcomes">The seven outcomes</H2>
      <P>
        Every indexed transfer ends in exactly one of these, and the reason is stored on the row rather than inferred later.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={120} />
      </P>

      <Table head={["Reason", "Condition", "Outcome", "Why not automatic"]} rows={[
        [<C key="a">router_fulfilment</C>, "Sender is Retainer's own router.", <><C>internal</C></>, <>Already reconciled as a pull. Recorded as a state rather than filtered away, so it stays countable. <Cite key="a1" file="apps/worker/src/matcher.js" line={67} /></>],
        [<C key="b">exact_known_sender</C>, <><C>|X| == 1</C></>, <b key="b1">auto_matched</b>, <>Nothing is left to judge: one known customer, one exact outstanding amount, one candidate. <Cite key="b2" file="apps/worker/src/matcher.js" line={81} /></>],
        [<C key="c">ambiguous_multiple_exact</C>, <><C>|X| &gt; 1</C></>, "needs_review", <>The sender is known and the amount is exact for more than one obligation. Choosing would be a coin toss with the merchant&apos;s ledger. <Cite key="c1" file="apps/worker/src/matcher.js" line={85} /></>],
        [<C key="d">amount_mismatch</C>, "Known sender, no exact-amount candidate.", "needs_review", <>A short payment is either a partial or an agreed discount. Those mean opposite things about whether money is still owed, and nothing in the data distinguishes them. <Cite key="d1" file="apps/worker/src/matcher.js" line={89} /></>],
        [<C key="e">unknown_sender</C>, "Amount matches exactly, sender not linked to anyone.", "needs_review", <>Attributing money to a customer on amount alone is how one customer&apos;s payment settles another&apos;s invoice. <Cite key="e1" file="apps/worker/src/matcher.js" line={96} /></>],
        [<C key="f">no_open_payment_for_sender</C>, "Sender is a known customer who owes nothing open.", "needs_review", <>An early payment, a duplicate, or not a payment. Calling it unattributed would be false — we know who sent it. <Cite key="f1" file="apps/worker/src/matcher.js" line={100} /></>],
        [<C key="g">unattributed</C>, "Neither sender nor amount corresponds to anything open.", "needs_review", <>Surfaced rather than discarded, so it can be attributed by hand instead of vanishing. <Cite key="g1" file="apps/worker/src/matcher.js" line={106} /></>],
      ]} />

      <P>
        Six of the seven end in <C>needs_review</C>. That ratio is the point, not a failing: the engine is tuned to be certain when
        it acts, and the cost of that is a queue. The <Link href="/docs/review-queue" className="text-brand-primary hover:underline">review
        queue</Link> is where that cost is paid down, and linking a sender is what stops it recurring.
      </P>

      <H2 id="candidates">What counts as a candidate</H2>
      <P>
        Only open obligations on the same chain and token, and never one that already has a charge <C>in_flight</C> or
        <C>confirmed</C> against it — two systems settling one obligation is where double-counting comes from.
        <Cite file="apps/worker/src/matcher.js" line={38} />
      </P>
      <P>
        Note what that exclusion does <i>not</i> do: such an obligation is still reviewable by a human. The engine refuses to pair
        them automatically; it does not pretend the obligation is invisible.
      </P>

      <H2 id="applying">Applying a match</H2>
      <P>
        Application locks the transfer row, so two concurrent applications cannot together exceed its value, and refuses outright to
        apply more than arrived. <Cite file="apps/worker/src/matcher.js" line={123} />
      </P>
      <Table head={["Case", "Result"]} rows={[
        ["Applied equals the remaining amount", <>Obligation becomes <C key="p">paid</C>, and <C key="q">payment.paid</C> is emitted.</>],
        ["Applied is less than remaining", <>Obligation becomes <C key="r">partially_paid</C> and stays outstanding for the difference.</>],
        ["Applied exceeds remaining", <>The excess is recorded as <C key="s">surplus</C> on the match rather than silently inflating the obligation. <Cite key="s1" file="apps/worker/src/matcher.js" line={133} /></>],
        ["Applied exceeds the transfer's own value", <>Refused. <Cite key="t" file="apps/worker/src/matcher.js" line={124} /></>],
      ]} />

      <P>
        Every match carries a <C>confidence</C>, and it records who decided rather than how sure anyone was: the matcher writes
        <C>exact_known_sender</C>, a human writes <C>manual</C>. <Cite file="apps/worker/src/matcher.js" line={186} /> The audit
        trail therefore always distinguishes a machine decision from a human one, which a numeric score would have blurred.
      </P>

      <H2 id="proof">How this is verified</H2>
      <P>
        All seven outcomes are driven end to end against real Base Sepolia transfers, and each assertion has a negative control
        that flips the one precondition that should change the verdict — confirmed to actually fail, because a check that passes
        because it never ran is worse than no check. <Cite file="scripts/phase2-drills.mjs" line={42} />
      </P>
      <Pre title="npm run drill:matching">{`case 1: exact, known sender      -> auto_matched / exact_known_sender
   control: unlink the sender    -> needs_review / unknown_sender
case 2: two exact candidates     -> needs_review / ambiguous_multiple_exact
   control: void one of the two  -> auto_matched / exact_known_sender
case 3: known sender, short      -> needs_review / amount_mismatch
   control: equalise the amount  -> auto_matched / exact_known_sender`}</Pre>
    </>
  );
}
