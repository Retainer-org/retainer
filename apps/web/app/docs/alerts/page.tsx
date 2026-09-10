import Link from "next/link";
import { H1, H2, P, UL, C, Cite, Callout, Table, Pre } from "@/components/docs/prose";

export default function Alerts() {
  return (
    <>
      <H1 lede="The merchant's actual request was not 'charge my customers'. It was 'I shouldn't have to think about whether the payment happened.' Overdue detection and alerting are the parts that answer it.">
        Overdue detection and alerts
      </H1>

      <P>
        Nobody noticing a missing payment was the pain, not charging. That distinction shapes this whole layer: the interesting
        event is not a successful charge, it is the absence of one past a date.
        <Cite file="apps/worker/src/sweep.js" line={7} />
      </P>

      <H2 id="sweep">One overdue path, not two</H2>
      <P>
        The sweep advances obligations through two transitions, and neither special-cases the fulfilment method. A pull whose
        charge failed terminally and a watch payment that never arrived are the same fact by the time they reach here: an
        expected payment past its due date with an outstanding balance.
        <Cite file="apps/worker/src/sweep.js" line={19} />
      </P>

      <Table head={["Transition", "Condition", "Emits"]} rows={[
        [<><C key="a">upcoming</C> → <C key="b">due</C></>, <>Inside the lead time: <C key="c">now() ≥ due_date − lead_time_seconds</C></>, "nothing — being due is not news"],
        [<><C key="d">due</C> | <C key="e">partially_paid</C> → <C key="f">overdue</C></>, <>Past the due date plus grace: <C key="g">now() &gt; due_date + grace_seconds</C></>, <><C key="h">payment.overdue</C> <Cite key="h1" file="apps/worker/src/sweep.js" line={39} /></>],
      ]} />

      <P>
        The overdue event carries what a merchant would act on rather than a bare identifier: whose obligation it is, how much is
        still outstanding, when it was due, and how it was meant to be satisfied.
        <Cite file="apps/worker/src/sweep.js" line={40} />
      </P>

      <Callout kind="note" title="Selective, not blanket">
        A sweep that moved everything would be indistinguishable from a broken one. The drill therefore asserts the negative case
        as well: an obligation beyond its lead time must stay <C>upcoming</C>, and no overdue event may be emitted for it.
        <Cite file="scripts/phase2-alerts-drills.mjs" line={69} />
      </Callout>

      <H2 id="events">The six event types</H2>
      <P>
        <Cite file="apps/worker/src/events.js" line={11} />
      </P>
      <Table head={["Event", "When"]} rows={[
        [<C key="a">payment.overdue</C>, "The sweep moved an obligation past its due date."],
        [<C key="b">payment.received</C>, "An incoming transfer was indexed and is not internal."],
        [<C key="c">payment.matched</C>, "A transfer was attributed to an obligation, automatically or by a human."],
        [<C key="d">payment.paid</C>, <>An obligation is fully settled — by either path, with <C key="d1">via</C> saying which.</>],
        [<C key="e">payment.needs_review</C>, "The matcher declined to guess."],
        [<C key="f">charge.failed</C>, "A pull failed, carrying the classifier's own verdict rather than a restatement."],
      ]} />

      <H2 id="emission">Emission and delivery are separate on purpose</H2>
      <P>
        An event is written inside the same database transaction as the state change that caused it, so an event exists if and only
        if the thing happened. There is no window in which an obligation is overdue but no event records it, and none in which an
        event describes something that was rolled back. <Cite file="apps/worker/src/events.js" line={7} />
      </P>
      <P>
        Delivery is the opposite kind of problem — a network call to someone else&apos;s server — so it is a separate, retried
        concern. Fan-out writes one delivery row per (event, destination), and the unique constraint makes it idempotent even if
        emission were somehow retried. <Cite file="apps/worker/src/events.js" line={33} /> The constraint is in the schema, not
        only in the code. <Cite file="packages/db/migrations/003_expected_payments.sql" line={237} />
      </P>

      <H2 id="webhooks">Webhook signing</H2>
      <P>
        Each webhook carries <C>Retainer-Signature: t=&lt;unix&gt;,v1=&lt;hmac&gt;</C>, an HMAC-SHA256 over
        <C>{"`${t}.${body}`"}</C>. The timestamp is inside the signed material rather than beside it, which is what stops a
        captured delivery being replayed later. <Cite file="apps/worker/src/alerts.js" line={23} />
      </P>
      <UL>
        <li>Verification rejects a signature older than five minutes, before comparing anything. <Cite file="apps/worker/src/alerts.js" line={37} /></li>
        <li>The comparison is constant-time. <Cite file="apps/worker/src/alerts.js" line={40} /></li>
        <li>Every delivery carries <C>retainer-event-id</C> so a receiver can dedupe: the same event must never become a second payment on their side. <Cite file="apps/worker/src/alerts.js" line={113} /></li>
        <li>The verifier is exported, so a receiver can use exactly the code that produced the signature. <Cite file="apps/worker/src/alerts.js" line={32} /></li>
      </UL>
      <P>
        All four properties are asserted in both directions: a correct signature verifies, and the wrong secret, a tampered body
        and a replayed timestamp each fail. <Cite file="scripts/phase2-alerts-drills.mjs" line={85} />
      </P>

      <H2 id="retry">Retry schedule</H2>
      <P>
        A failed delivery backs off over roughly a day before being abandoned, and the attempt count lives on the delivery row
        rather than in memory. <Cite file="apps/worker/src/alerts.js" line={17} />
      </P>
      <Pre title="apps/worker/src/alerts.js">{`BACKOFF_SECONDS = [60, 300, 1500, 7200, 21600, 86400]
                    1m   5m   25m   2h    6h     24h   -> then dead`}</Pre>
      <P>
        The drill proves retry actually happens by making the receiver reject the first two attempts and requiring the delivery to
        succeed anyway. <Cite file="scripts/phase2-alerts-drills.mjs" line={106} />
      </P>

      <H2 id="email">Email is behind a transport boundary</H2>
      <P>
        Email is one function with one shape, chosen by <C>ALERT_EMAIL_TRANSPORT</C>. Adding Resend or SMTP is one entry in a map
        and no caller changes. <Cite file="apps/worker/src/alerts.js" line={46} />
      </P>
      <P>
        Today only <C>file</C> and <C>console</C> exist. That is stated rather than dressed up: no real email has ever been sent by
        this system. What is proven is the boundary — the delivery row records which transport handled it, and the file transport
        is asserted to have actually written the message.
        <Cite file="scripts/phase2-alerts-drills.mjs" line={114} />
      </P>

      <Callout kind="limit" title="What is not built">
        There is no alert-destination management interface; destinations are added programmatically.
        <Cite file="apps/worker/src/alerts.js" line={173} /> There is no digest or quiet-hours logic, and no per-merchant routing
        beyond an optional event-type filter on a destination. See <Link href="/docs/limitations" className="text-brand-primary hover:underline">current limitations</Link>.
      </Callout>
    </>
  );
}
