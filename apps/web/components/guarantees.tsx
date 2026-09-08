import { Container } from "./container";
import { Heading } from "./heading";
import { Subheading } from "./subheading";

// Adapted from the template's second feature section. Each block is something
// that has been exercised on Base Sepolia, not something planned.
export function Guarantees() {
  return (
    <Container as="section" id="guarantees" className="scroll-mt-24 px-4 py-10 md:py-20 lg:py-32">
      <div className="mx-auto mb-16 max-w-2xl text-center">
        <Heading as="h2" className="mb-4">What the engine guarantees</Heading>
        <Subheading className="text-balance">Each of these has been triggered deliberately on testnet, with the transaction hashes in the repo.</Subheading>
      </div>

      <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-3">
        <Block title="Exactly-once charging" mono="1 spend per period, proven">
          The signed transaction is persisted with its hash before it is broadcast. If the process dies after the send,
          recovery finds the receipt. If another transaction took the nonce, the attempt is marked superseded and retried fresh.
          Both branches were forced deliberately; each produced exactly one on-chain spend.
        </Block>
        <Block title="Failures classified before gas is spent" mono="6 modes · 0 wasted transactions">
          Revoked, expired, insufficient balance, allowance exhausted, not started, not approved — read from chain state
          before broadcasting, each with its own disposition. Revoked and expired are terminal; the rest know when to try again.
        </Block>
        <Block title="Paid means reconciled" mono="never on broadcast">
          A charge is confirmed only when both the manager&apos;s <code className="font-mono text-xs">SpendPermissionUsed</code> and the
          router&apos;s <code className="font-mono text-xs">SpendRouted</code> events are indexed for that transaction, and the router paid the
          recipient we intended. Every confirmed row maps to one transaction hash.
        </Block>
      </div>

      <p className="mx-auto mt-12 max-w-3xl text-center text-sm text-neutral-600 dark:text-neutral-400">
        A routed charge is roughly 135–150k gas. At the Base fees we measured, that is about half a cent per charge —
        under 0.4% of a $3 subscription, where card rails take more than ten percent.
      </p>
    </Container>
  );
}

function Block({ title, mono, children }: { title: string; mono: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10">
      <div className="rounded-lg bg-neutral-100 px-3 py-2 font-mono text-xs text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">{mono}</div>
      <h3 className="mt-4 text-sm font-semibold text-neutral-900 dark:text-white">{title}</h3>
      <p className="mt-2 text-sm text-balance text-neutral-600 dark:text-neutral-400">{children}</p>
    </div>
  );
}
