import Link from "next/link";
import { Badge } from "./badge";

const ROUTER = "0x337099eE403C090388A66cc9370F7b0Fe4CDcC79";

// Adapted from the template hero. The "window" that held a product screenshot
// now holds the integration itself, because for this audience the code is the
// screenshot. Decorative shader dropped.
export default function Hero() {
  return (
    <div className="relative w-full overflow-hidden bg-white dark:bg-neutral-950">
      <div className="relative z-10 mx-auto max-w-7xl px-4 pt-28 pb-12 md:px-8 md:pt-40 md:pb-24">
        <Badge href="/#contract">Running on Base Sepolia · not on mainnet</Badge>

        <h1 className="mt-4 max-w-3xl text-4xl font-medium tracking-tight text-neutral-700 md:text-7xl dark:text-neutral-300">
          Recurring USDC billing that never holds the money.
        </h1>

        <p className="mt-4 max-w-2xl text-base text-neutral-700 md:text-xl dark:text-neutral-300">
          Retainer charges on schedule against Base spend permissions. Funds move
          customer → router → merchant in one atomic transaction, and the router&apos;s
          balance is zero after every charge. A billing engine, not a wallet.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Link href={`https://sepolia.basescan.org/address/${ROUTER}#code`} target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-6 py-3 text-base font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200">
            Verified contract <Arrow className="size-4" />
          </Link>
          <Link href="https://github.com/Retainer-org/retainer" target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center rounded-md bg-white px-6 py-3 text-base font-medium text-neutral-700 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 dark:bg-neutral-800 dark:text-neutral-200 dark:ring-neutral-700 dark:hover:bg-neutral-700">
            Read the source
          </Link>
        </div>

        <div className="mt-16 md:mt-24">
          <div className="overflow-hidden rounded-xl border border-neutral-300/50 bg-white/70 backdrop-blur-sm dark:border-neutral-700/50 dark:bg-neutral-900/70">
            <div className="flex items-center gap-2 border-b border-neutral-200/50 px-4 py-3 dark:border-neutral-700/50">
              <div className="flex items-center gap-1.5">
                <div className="size-3 rounded-full bg-red-500" /><div className="size-3 rounded-full bg-yellow-500" /><div className="size-3 rounded-full bg-green-500" />
              </div>
              <div className="flex-1 text-center"><span className="text-xs text-neutral-500 dark:text-neutral-400">merchant/billing.ts</span></div>
              <div className="w-12" />
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-6 text-neutral-800 md:text-sm dark:text-neutral-200"><code>{`// 1. The customer signs once. Retainer registers it on-chain and pays the gas.
const permission = await requestSpendPermission({
  account,
  spender: RETAINER_ROUTER,                 // 0x3370…cC79, verified on Basescan
  token: USDC,
  allowance: 20_000_000n,                   // 20 USDC per period — a ceiling, not a price
  periodInDays: 30,                         // resets on-chain; nothing carries over
  extraData: encodeExtraData(executor, merchantTreasury),
  provider,
});

// 2. Charge whatever this period actually cost, up to the cap, when it's due.
await enqueueCharge({ permission, amount: usageThisPeriod });

// 3. "Paid" means the on-chain events say so — never that a transaction was sent.`}</code></pre>
          </div>
        </div>
      </div>
    </div>
  );
}

const Arrow = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14M15 16l4-4M15 8l4 4" /></svg>
);
