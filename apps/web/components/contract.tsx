import Link from "next/link";
import { Container } from "./container";
import { Heading } from "./heading";
import { Subheading } from "./subheading";

const ROUTER = "0x337099eE403C090388A66cc9370F7b0Fe4CDcC79";
const MANAGER = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";

export function Contract() {
  return (
    <Container as="section" id="contract" className="scroll-mt-24 py-10 md:py-20 lg:py-32">
      <div className="mx-auto max-w-3xl">
        <Heading as="h2">The contracts</Heading>
        <Subheading className="mt-2">Nothing here is ours to audit. We deploy an unmodified instance of Coinbase&apos;s audited router.</Subheading>

        <dl className="mt-10 divide-y divide-neutral-200 rounded-2xl bg-white shadow-sm ring-1 ring-black/10 dark:divide-white/10 dark:bg-neutral-900 dark:ring-white/10">
          <Row k="SpendRouter · Retainer&apos;s instance" note="Verified source on Basescan. Deployed by us, logic untouched.">
            <Link href={`https://sepolia.basescan.org/address/${ROUTER}#code`} target="_blank" rel="noopener noreferrer" className="font-mono text-sm break-all text-brand-primary hover:underline">{ROUTER}</Link>
          </Row>
          <Row k="SpendPermissionManager · canonical" note="Not redeployed. Its on-chain EIP-712 typehash matches the source we vendor.">
            <Link href={`https://sepolia.basescan.org/address/${MANAGER}`} target="_blank" rel="noopener noreferrer" className="font-mono text-sm break-all text-brand-primary hover:underline">{MANAGER}</Link>
          </Row>
          <Row k="Source" note="coinbase/spend-permissions @ e0004e6, vendored verbatim. A script re-checks it against upstream by sha256.">
            <Link href="https://github.com/coinbase/spend-permissions" target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-brand-primary hover:underline">github.com/coinbase/spend-permissions</Link>
          </Row>
          <Row k="Network" note="Base Sepolia, chain 84532. There is no mainnet deployment.">
            <span className="font-mono text-sm text-neutral-900 dark:text-neutral-100">testnet only</span>
          </Row>
        </dl>
      </div>
    </Container>
  );
}

function Row({ k, note, children }: { k: string; note: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 p-5 md:grid-cols-[13rem_1fr]">
      <dt className="text-sm font-medium text-neutral-900 dark:text-white" dangerouslySetInnerHTML={{ __html: k }} />
      <dd>
        {children}
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{note}</p>
      </dd>
    </div>
  );
}
