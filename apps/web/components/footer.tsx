import Link from "next/link";
import { ModeToggle } from "./mode-toggle";

// Adapted from the template's footer. Every link here resolves to something that
// exists. No socials, no legal pages, no register column.
const ROUTER = "0x337099eE403C090388A66cc9370F7b0Fe4CDcC79";

export function Footer() {
  const cols = [
    { title: "Project", items: [
      { title: "Source on GitHub", href: "https://github.com/Retainer-org/retainer" },
      { title: "Signing harness (limited)", href: "/sign" },
    ]},
    { title: "On-chain", items: [
      { title: "SpendRouter (verified)", href: `https://sepolia.basescan.org/address/${ROUTER}#code` },
      { title: "SpendPermissionManager", href: "https://sepolia.basescan.org/address/0xf85210B21cC50302F477BA56686d2019dC9b67Ad" },
      { title: "coinbase/spend-permissions", href: "https://github.com/coinbase/spend-permissions" },
    ]},
  ];
  return (
    <div className="relative w-full overflow-hidden border-t border-neutral-100 bg-white px-8 pt-20 dark:border-white/10 dark:bg-neutral-950">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between text-sm text-neutral-500 sm:flex-row md:px-8">
        <div>
          <Link href="/" className="text-base font-semibold text-black dark:text-white">Retainer</Link>
          <p className="mt-3 max-w-xs text-neutral-500 dark:text-neutral-400">
            Recurring and usage-based USDC billing on Base spend permissions. Base Sepolia only.
          </p>
          <div className="mt-4 flex items-center gap-4"><ModeToggle /></div>
        </div>
        <div className="mt-10 grid grid-cols-2 items-start gap-10 sm:mt-0">
          {cols.map((c) => (
            <div key={c.title} className="flex flex-col gap-4">
              <p className="font-bold text-neutral-600 dark:text-neutral-300">{c.title}</p>
              <ul className="flex flex-col gap-4 text-neutral-600 dark:text-neutral-300">
                {c.items.map((i) => (
                  <li key={i.title}>
                    <Link href={i.href} className="transition-colors hover:text-neutral-800 dark:hover:text-white"
                      {...(i.href.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                      {i.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="relative mt-20 h-[calc(clamp(3rem,18vw,20rem)*0.75)] w-full overflow-hidden">
        <p className="absolute inset-x-0 top-0 w-full text-center leading-none font-bold text-transparent" style={{ fontSize: "clamp(3rem, 18vw, 20rem)", letterSpacing: "-0.02em" }}>
          <span className="dark:hidden" style={{ WebkitTextStroke: "1px var(--color-neutral-200)" }}>Retainer</span>
          <span className="hidden dark:inline" style={{ WebkitTextStroke: "1px var(--color-neutral-700)" }}>Retainer</span>
        </p>
      </div>
    </div>
  );
}
