import React from "react";
import { cn } from "@/lib/utils";
import { Container } from "./container";
import { Heading } from "./heading";
import { Subheading } from "./subheading";

// Adapted from the template's first bento section. Same card grid; the
// illustrations are replaced with small diagrams of what actually happens.
export function HowItWorks() {
  return (
    <Container as="section" id="how-it-works" className="scroll-mt-24 py-10 md:py-20 lg:py-32">
      <Heading as="h2">How a charge works</Heading>
      <Subheading className="mt-2">One signature from the customer. Everything after that is on-chain-enforced.</Subheading>

      <div className="mx-auto mt-8 grid grid-cols-1 gap-4 md:mt-12 md:grid-cols-3 md:grid-rows-2">
        <Card className="md:row-span-2">
          <CardHeader>
            <CardTitle>The customer signs a bounded permission</CardTitle>
            <CardDescription>
              A Base spend permission names the spender, the token, an allowance per period, a period length, a start and an end.
              The cap resets on-chain at every period boundary and unused allowance does not carry forward. The customer can revoke at any time,
              and revocation takes effect the block it&apos;s mined. None of this is enforced by Retainer — the contract does it.
            </CardDescription>
          </CardHeader>
          <Diagram className="mt-auto">
            <Field k="spender" v="Retainer router" /><Field k="token" v="USDC" /><Field k="allowance" v="20 USDC / period" />
            <Field k="period" v="30 days, resets on-chain" /><Field k="revocable" v="yes, instantly" />
          </Diagram>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Retainer registers it and pays the gas</CardTitle>
            <CardDescription>
              <code className="font-mono text-xs">approveWithSignature</code> is permissionless, so our executor submits it. The customer signs, never transacts.
            </CardDescription>
          </CardHeader>
        </Card>

        <Card className="md:row-span-2">
          <CardHeader>
            <CardTitle>Funds never rest with Retainer</CardTitle>
            <CardDescription>
              A charge is one transaction: the router pulls from the customer and forwards to the merchant treasury atomically.
              If the forward fails, the whole thing reverts. The router&apos;s USDC balance is zero after every charge —
              asserted by a fuzz test that fails the build, and observed on-chain after every charge we&apos;ve run.
            </CardDescription>
          </CardHeader>
          <Diagram className="mt-auto">
            <Flow />
          </Diagram>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>The amount is decided at charge time</CardTitle>
            <CardDescription>
              Fixed or metered. A usage charge is enqueued with no amount and computed from recorded usage when it runs — anything up to the cap.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    </Container>
  );
}

function Diagram({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-6 pb-6", className)}>{children}</div>;
}
function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-neutral-100 py-2 font-mono text-xs first:border-t-0 dark:border-white/10">
      <span className="text-neutral-500 dark:text-neutral-400">{k}</span><span className="text-neutral-900 dark:text-neutral-100">{v}</span>
    </div>
  );
}
function Flow() {
  const step = "rounded-lg bg-neutral-100 px-3 py-2 text-center font-mono text-xs text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100";
  return (
    <div className="flex flex-col gap-2">
      <div className={step}>customer account</div>
      <div className="text-center text-neutral-400">↓ spend(permission, value)</div>
      <div className={cn(step, "ring-1 ring-brand-primary/50")}>router · balance after: 0</div>
      <div className="text-center text-neutral-400">↓ same transaction</div>
      <div className={step}>merchant treasury</div>
    </div>
  );
}
function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col rounded-2xl bg-white shadow-sm ring-1 shadow-black/10 ring-black/10 dark:bg-neutral-900 dark:shadow-white/5 dark:ring-white/10", className)}>{children}</div>;
}
function CardHeader({ children }: { children: React.ReactNode }) { return <div className="flex flex-col gap-2 p-6">{children}</div>; }
function CardTitle({ children }: { children: React.ReactNode }) { return <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">{children}</h3>; }
function CardDescription({ children }: { children: React.ReactNode }) { return <p className="text-sm text-balance text-neutral-600 dark:text-neutral-400">{children}</p>; }
