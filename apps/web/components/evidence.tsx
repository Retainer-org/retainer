import Link from "next/link";
import { Container } from "./container";
import { Heading } from "./heading";
import { Subheading } from "./subheading";

// The section above the footer says "read it, run it, sign it yourself".
// So this is the evidence: the six confirmed charges with their real
// transaction hashes, and the crash-recovery result. Every hash is in the
// README and on Base Sepolia; anyone can click through and check.

const TX = (h: string) => `https://sepolia.basescan.org/tx/${h}`;
const usdc = (n: number) => (n / 1_000_000).toFixed(6);

const CHARGES = [
  { id: 1,  kind: "fixed", requested: 1_000_000, settled: 1_000_000, block: 46565605, tx: "0x91a4980a793c29276f55871b4f2a372d2c4f3170ec06f61dfd20d3a6948a1e7c" },
  { id: 8,  kind: "fixed", requested: 1_500_000, settled: 1_500_000, block: 46565695, tx: "0x35043fd149c096816da7f64a2270dba1ae758c021945f11dcf357bf6ba8aaa93" },
  { id: 9,  kind: "usage", requested: 1_250_000, settled: 1_250_000, block: 46565760, tx: "0x55c0e2b51f9580bf05e272a3e9e5b5d90d4ec8f0f9b308192126b7117b9bea3d" },
  { id: 10, kind: "fixed", requested: 1_100_000, settled: 1_100_000, block: 46565785, tx: "0x8e4ce873249fc57b52485086de99aa4a0b9e341a7165916282153bbf9f68e2df", note: "crash A" },
  { id: 11, kind: "fixed", requested: 1_300_000, settled: 1_300_000, block: 46565838, tx: "0xe0ac2a1eed2bb2a5ea4c0a6ee418d4edb37c2320f488fa6b5eb2026aabb5244d", note: "crash B" },
  { id: 12, kind: "fixed", requested:   900_000, settled:   900_000, block: 46566640, tx: "0xa90432814929063ed876f09f540ea2eea8e44188602f73c8095589cf1a545103" },
] as const;

const TOTAL = CHARGES.reduce((s, c) => s + c.settled, 0);

const CRASH = {
  a: { landed: "0x8e4ce873249fc57b52485086de99aa4a0b9e341a7165916282153bbf9f68e2df" },
  b: {
    superseded: "0x0a078798bcc3d5c5947a4c21687fed79a79332c1521b4b4900d62bfd2e9131a3",
    competing:  "0x21cd8eb371c6557815715a4b69140c183f5b3981237d76c7724269f01622c32d",
    final:      "0xe0ac2a1eed2bb2a5ea4c0a6ee418d4edb37c2320f488fa6b5eb2026aabb5244d",
  },
};

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

export function Evidence() {
  return (
    <Container as="section" id="evidence" className="scroll-mt-24 py-10 md:py-20 lg:py-32">
      <div className="max-w-2xl">
        <Heading as="h2" className="text-3xl font-bold tracking-tight text-balance text-black md:text-4xl dark:text-white">
          Read it, run it, or sign a permission yourself.
        </Heading>
        <Subheading className="mt-4 text-base text-neutral-600 dark:text-neutral-400">
          Below are the six confirmed charges from the test drills and the crash-recovery runs — real Base Sepolia transactions.
          Every hash links to Basescan. Requested and settled amounts are shown side by side so the match is checkable, not asserted.
        </Subheading>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="https://github.com/Retainer-org/retainer" target="_blank" rel="noopener noreferrer" className="rounded-md bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200">Source on GitHub</Link>
          <Link href="/try" className="rounded-md bg-white px-5 py-2.5 text-sm font-medium text-neutral-700 ring-1 ring-neutral-200 hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700 dark:hover:bg-neutral-700">Try it: authorise a test payment</Link>
        </div>
      </div>

      {/* six confirmed charges */}
      <div className="mt-12 overflow-x-auto rounded-2xl bg-white shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
            <tr>
              <th className="px-4 py-3 font-medium">Charge</th>
              <th className="px-4 py-3 font-medium">Amount</th>
              <th className="px-4 py-3 text-right font-medium">Requested</th>
              <th className="px-4 py-3 text-right font-medium">Settled on-chain</th>
              <th className="px-4 py-3 font-medium">Block</th>
              <th className="px-4 py-3 font-medium">Transaction</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 font-mono text-[13px] dark:divide-white/5">
            {CHARGES.map((c) => (
              <tr key={c.id} className="text-neutral-800 dark:text-neutral-200">
                <td className="px-4 py-3">#{c.id}{"note" in c && <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{c.note}</span>}</td>
                <td className="px-4 py-3 font-sans text-xs">
                  {c.kind === "usage"
                    ? <span className="rounded bg-brand-primary/10 px-1.5 py-0.5 text-brand-primary">usage · computed at charge time</span>
                    : <span className="text-neutral-500 dark:text-neutral-400">fixed</span>}
                </td>
                <td className="px-4 py-3 text-right">{usdc(c.requested)}</td>
                <td className="px-4 py-3 text-right">{usdc(c.settled)} <span className="text-neutral-400">USDC</span></td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">{c.block}</td>
                <td className="px-4 py-3"><Link href={TX(c.tx)} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{short(c.tx)}</Link></td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-neutral-200 font-mono text-[13px] dark:border-white/10">
            <tr className="text-neutral-800 dark:text-neutral-200">
              <td className="px-4 py-3 font-sans text-xs text-neutral-500 dark:text-neutral-400" colSpan={3}>Sum of settled amounts</td>
              <td className="px-4 py-3 text-right font-semibold">{usdc(TOTAL)} <span className="font-normal text-neutral-400">USDC</span></td>
              <td className="px-4 py-3 font-sans text-xs text-neutral-500 dark:text-neutral-400" colSpan={2}>equals the treasury balance; router balance 0 — checked 2026-09-09</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* crash recovery */}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <CrashCard title="A · killed after the send, before the row updated" outcome="Recovery found the receipt on-chain. Exactly one spend.">
          <Row label="the one transaction (charge #10, nonce 22)" hash={CRASH.a.landed} />
        </CrashCard>
        <CrashCard title="B · killed after signing, before the send; nonce then taken by another transaction" outcome="Recovery marked the attempt superseded and did not re-broadcast. Charged once on a fresh nonce.">
          <Row label="superseded attempt — never landed, by design" hash={CRASH.b.superseded} dead />
          <Row label="competing transaction that consumed nonce 24" hash={CRASH.b.competing} />
          <Row label="the one spend (charge #11, nonce 25)" hash={CRASH.b.final} />
        </CrashCard>
      </div>
    </Container>
  );
}

function CrashCard({ title, outcome, children }: { title: string; outcome: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
      <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Crash recovery {title}</h3>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{outcome}</p>
      <dl className="mt-4 space-y-2">{children}</dl>
    </div>
  );
}

function Row({ label, hash, dead }: { label: string; hash: string; dead?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="font-mono text-[13px]">
        {dead
          ? <span className="text-neutral-500 line-through decoration-neutral-400 dark:text-neutral-400">{short(hash)}</span>
          : <Link href={TX(hash)} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{short(hash)}</Link>}
        {dead && <span className="ml-2 font-sans text-xs text-neutral-500 dark:text-neutral-400">not on Basescan — it was never mined</span>}
      </dd>
    </div>
  );
}
