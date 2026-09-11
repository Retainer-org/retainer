import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";
import { Architecture } from "@/components/docs/architecture";

export default function ExpectedPayments() {
  return (
    <>
      <H1 lede="The obligation is the top-level object, not the charge. A charge is one way to satisfy it; a matched incoming transfer is the other. Both are first-class, which is what gives overdue detection a single path instead of two.">
        Expected payments
      </H1>

      <P>
        Phase 1 made the charge the top-level object. That was the wrong shape, and the reason is visible the moment a payer cannot
        use a spend permission at all: there is nothing left to represent the money the merchant is still owed. An
        <C>expected_payment</C> is that thing — an amount, a token, a due date, a state, and a <i>fulfilment method</i> saying how it
        is meant to be satisfied. <Cite file="packages/db/migrations/003_expected_payments.sql" line={70} />
      </P>

      <Architecture caption="One obligation, two ways to satisfy it. The merchant's question is 'did I get paid', not 'did the charge succeed'." />

      <H2 id="unifies">Why one abstraction rather than two systems</H2>
      <P>
        The tempting design is two parallel systems: a charge pipeline with its own failure handling, and a transfer watcher with
        its own. It looks simpler until you ask the only question the merchant actually has — <i>am I owed money that has not
        arrived?</i> — and discover the answer has to be assembled from two places that disagree about what &ldquo;late&rdquo; means.
      </P>
      <P>
        Making the obligation primary collapses that. A pull whose charge failed terminally and a watch payment that never arrived
        are the same fact: an expected payment past its due date with an outstanding balance. One sweep finds both, and one alert
        describes both. <Cite file="apps/worker/src/sweep.js" line={11} />
      </P>

      <Callout kind="note" title="The migration was a re-shaping, not a rewrite">
        Every one of the twelve existing charges became the fulfilment of a backfilled expected payment, keeping its transaction
        hashes and its idempotency key untouched. Charges did not lose their <C>UNIQUE (permission_id, period_start)</C> guarantee;
        they gained a parent. <Cite file="packages/db/migrations/003_expected_payments.sql" line={244} />
      </Callout>

      <H2 id="states">The six states</H2>
      <P>
        Terminal states are terminal: <C>paid</C> and <C>void</C> are never left. Everything else can still move.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={59} />
      </P>

      <Table head={["State", "Meaning", "How it is entered"]} rows={[
        [<C key="a">upcoming</C>, "The due date is further away than the lead time.", "Created this way."],
        [<C key="b">due</C>, "Inside the lead time, not yet satisfied.", <>The sweep moves it once <C>now() ≥ due_date − lead_time_seconds</C>. <Cite file="apps/worker/src/sweep.js" line={25} /></>],
        [<C key="c">overdue</C>, "Past the due date plus grace, still not satisfied.", <>The sweep moves it once <C>now() &gt; due_date + grace_seconds</C>, and emits <C>payment.overdue</C>. <Cite file="apps/worker/src/sweep.js" line={32} /></>],
        [<C key="d">partially_paid</C>, <>0 &lt; settled &lt; expected, every unit of it confirmed on-chain.</>, <>A match applied less than the full amount, or a charge confirmed short. <Cite file="apps/worker/src/matcher.js" line={144} /></>],
        [<C key="e">paid</C>, "Settled at or above the expected amount. Terminal.", <>Either the reconciler confirmed the charge behind it, or a matched transfer covered it. <Cite file="apps/worker/src/sweep.js" line={73} /></>],
        [<C key="f">void</C>, "Cancelled by the merchant. Terminal.", "Not reachable from the dashboard; the review actions cannot void an obligation."],
      ]} />

      <P>
        <C>lead_time_seconds</C> defaults to three days and <C>grace_seconds</C> to zero, both per-obligation rather than global,
        because &ldquo;when should I be told&rdquo; is a merchant policy and not a property of the engine.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={83} />
      </P>

      <H2 id="fulfilment">Fulfilment is declared, not inferred</H2>
      <P>
        An obligation says up front how it is meant to be satisfied — <C>pull</C> or <C>watch</C> — and the schema refuses the
        incoherent case: a pull without a permission cannot be stored at all.
        <Cite file="packages/db/migrations/003_expected_payments.sql" line={94} />
      </P>
      <Pre title="packages/db/migrations/003_expected_payments.sql">{`CONSTRAINT expected_payments_pull_needs_permission
  CHECK (fulfilment <> 'pull' OR permission_id IS NOT NULL)`}</Pre>
      <P>
        The declaration is not a filter on what may satisfy it. A watch obligation is still settled by a transfer that had to be
        reviewed by hand, and a pull obligation whose charge failed is still visible to the matcher as something a transfer could
        pay — just never automatically. What the declaration buys is the ability to say, on the dashboard and in an alert, how this
        payment was <i>supposed</i> to arrive, which is most of what a merchant needs to know when it has not.
      </P>

      <H2 id="double">The double-settlement guard</H2>
      <P>
        Two systems settling one obligation is where double-counting comes from, so the matcher&apos;s candidate query excludes any
        obligation that already has a charge <C>in_flight</C> or <C>confirmed</C> against it. Such a payment is still
        <i>reviewable</i> — a human can look at it — it simply can never be matched automatically.
        <Cite file="apps/worker/src/matcher.js" line={38} />
      </P>
      <P>
        The database backs the same rule from the other side: a charge is unique per expected payment, so the engine cannot enqueue
        two pulls for one obligation even if asked twice. <Cite file="packages/db/migrations/003_expected_payments.sql" line={290} />
      </P>

      <Callout kind="warn" title="Settlement still comes from the chain, never from intent">
        Nothing here marks an obligation paid because a charge was sent. The reconciler remains the sole writer of
        <C>charges.state = &apos;confirmed&apos;</C>, and this layer reads that verdict rather than forming its own.
        <Cite file="apps/worker/src/sweep.js" line={54} /> On the watch side the equivalent is three confirmations before a transfer
        is eligible to be matched at all. See <Link href="/docs/watch-mode" className="text-brand-primary hover:underline">watch mode</Link>.
      </Callout>

      <H2 id="seeing">Seeing it</H2>
      <UL>
        <li>The dashboard&apos;s <Link href="/dashboard/expected" className="text-brand-primary hover:underline">expected payments</Link> page lists every obligation with its outstanding balance and how it is meant to be satisfied. <Cite file="apps/web/app/dashboard/expected/page.tsx" line={15} /></li>
        <li>Evidence is a link to the confirming transaction for a pull, or the count of matched transfers for a watch. <Cite file="apps/web/app/dashboard/expected/page.tsx" line={74} /></li>
        <li>The loader is database-only: nothing on that page is fetched from the chain at render time. <Cite file="apps/web/lib/dashboard-data.ts" line={250} /></li>
      </UL>
    </>
  );
}
