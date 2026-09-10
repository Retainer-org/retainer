import type { ReactNode } from "react";

/**
 * The whole system in one picture: who signs, who calls whom, where the money
 * goes, and the two ways an expected payment can be satisfied.
 *
 * Inline SVG on purpose -- no dependency, no image asset to drift out of date,
 * and every colour is a Tailwind theme class so it follows light and dark
 * without a second copy. The flow dashes animate only when the reader has not
 * asked for reduced motion; the static form is the default and carries all the
 * same information, so nothing is conveyed by movement alone.
 *
 * Call direction matches the contracts: the worker calls
 * SpendRouter.spendAndRoute (apps/worker/src/charger.js), the router calls
 * PERMISSION_MANAGER.spend (contracts/src/SpendRouter.sol), and the manager
 * executes the transfer on the customer's wallet.
 */

const BOX = "fill-white dark:fill-neutral-900";
const EDGE = "stroke-neutral-300 dark:stroke-white/20";
const LINE = "stroke-neutral-400 dark:stroke-neutral-500";
const SATISFIES = "stroke-brand-primary/70";
const TITLE = "fill-neutral-900 dark:fill-white";
const SUB = "fill-neutral-500 dark:fill-neutral-400";
const LANE = "fill-neutral-400 dark:fill-neutral-500";
const NOTE = "fill-brand-primary";

function Node({ x, y, w = 168, h = 60, title, sub, accent }: {
  x: number; y: number; w?: number; h?: number; title: string; sub?: string; accent?: boolean;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10}
        className={`${BOX} ${accent ? "stroke-brand-primary/60" : EDGE}`} strokeWidth={accent ? 1.5 : 1} />
      <text x={x + w / 2} y={y + (sub ? 25 : 34)} textAnchor="middle" className={`${TITLE} text-[13px] font-semibold`}>{title}</text>
      {sub && <text x={x + w / 2} y={y + 42} textAnchor="middle" className={`${SUB} text-[11px]`}>{sub}</text>}
    </g>
  );
}

export function Architecture({ caption }: { caption?: ReactNode }) {
  return (
    // The prose column is narrower than the diagram needs to stay legible, so
    // the figure reclaims the column's own padding on wider screens rather than
    // shrinking the type. Below that it scrolls inside its container.
    <figure className="my-8 md:-mx-10">
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-white/10 dark:bg-neutral-900/60">
        <svg viewBox="0 0 920 494" className="mx-auto block h-auto w-full min-w-[720px]" role="img"
          aria-labelledby="arch-title arch-desc">
          <title id="arch-title">Retainer system architecture</title>
          <desc id="arch-desc">
            An expected payment is satisfied by one of two paths. In the pull path, a customer&apos;s Base Account signs a spend
            permission once. Retainer&apos;s worker calls Retainer&apos;s SpendRouter, the router calls the SpendPermissionManager, and
            the manager moves USDC from the customer&apos;s wallet to the router, which forwards the full value to the merchant
            treasury in the same transaction. A confirmed charge settles the obligation. In the watch path, any payer, including a
            Safe multisig, sends USDC directly to the treasury; the worker indexes the transfer and a matched transfer settles the
            obligation. Retainer never holds the money on either path.
          </desc>

          <style>{`
            @media (prefers-reduced-motion: no-preference) {
              .flow { stroke-dasharray: 7 7; animation: arch-flow 1.1s linear infinite; }
              @keyframes arch-flow { to { stroke-dashoffset: -28; } }
            }
          `}</style>

          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-neutral-400 dark:fill-neutral-500" />
            </marker>
            <marker id="arrow-brand" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-brand-primary" />
            </marker>
          </defs>

          {/* ---------------------------------------------------- lane 1: pull */}
          <text x="14" y="24" className={`${LANE} text-[11px] font-semibold tracking-wide`}>PULL — SPEND PERMISSION</text>
          <Node x={360} y={34} w={200} h={56} title="SpendPermissionManager" sub="executes on the customer's wallet" />
          <Node x={14}  y={120} title="Customer" sub="Base Account (ERC-4337)" />
          <Node x={360} y={120} w={200} title="SpendRouter" sub="Retainer's own instance" accent />

          {/* authorisation, not money: signed once, enforced by the manager */}
          <path d="M 98 120 L 98 62 L 360 62" fill="none" className={LINE} strokeWidth="1.2" strokeDasharray="3 4" markerEnd="url(#arrow)" />
          <text x="229" y="54" textAnchor="middle" className={`${SUB} text-[10px]`}>signs a spend permission, once</text>

          {/* the router calls the manager */}
          <line x1="460" y1="120" x2="460" y2="92" className={LINE} strokeWidth="1.2" markerEnd="url(#arrow)" />
          <text x="466" y="110" className={`${SUB} text-[10px]`}>spend()</text>

          {/* money: customer -> router -> treasury, one transaction */}
          <line x1="182" y1="150" x2="358" y2="150" className={`${LINE} flow`} strokeWidth="1.6" markerEnd="url(#arrow)" />
          <text x="271" y="142" textAnchor="middle" className={`${SUB} text-[10px]`}>USDC, one atomic transaction</text>
          <path d="M 560 150 L 795 150 L 795 220" fill="none" className={`${LINE} flow`} strokeWidth="1.6" markerEnd="url(#arrow)" />
          <text x="678" y="142" textAnchor="middle" className={`${SUB} text-[10px]`}>forwards the full value</text>

          {/* ------------------------------------------------------- treasury */}
          <Node x={700} y={222} w={190} title="Merchant treasury" sub="receives on both paths" accent />

          {/* -------------------------------------------- the obligation itself */}
          <rect x="14" y="214" width="316" height="76" rx={10} className={`${BOX} stroke-brand-primary/50`} strokeWidth="1.5" strokeDasharray="5 4" />
          <text x="172" y="240" textAnchor="middle" className={`${TITLE} text-[13px] font-semibold`}>Expected payment</text>
          <text x="172" y="258" textAnchor="middle" className={`${SUB} text-[11px]`}>amount, due date, state</text>
          <text x="172" y="276" textAnchor="middle" className={`${SUB} text-[11px]`}>overdue if neither path settles it</text>

          <line x1="280" y1="152" x2="280" y2="212" className={SATISFIES} strokeWidth="1.3" strokeDasharray="4 4" markerEnd="url(#arrow-brand)" />
          <text x="288" y="196" className={`${NOTE} text-[10px]`}>settled by a confirmed charge</text>
          <line x1="280" y1="348" x2="280" y2="292" className={SATISFIES} strokeWidth="1.3" strokeDasharray="4 4" markerEnd="url(#arrow-brand)" />
          <text x="288" y="312" className={`${NOTE} text-[10px]`}>or by a matched transfer</text>

          {/* --------------------------------------------------- lane 2: watch */}
          <text x="14" y="314" className={`${LANE} text-[11px] font-semibold tracking-wide`}>WATCH — INCOMING TRANSFER</text>
          <Node x={14} y={322} w={230} h={56} title="Payer" sub="Safe multisig, DAO, any wallet" />

          <path d="M 244 350 L 795 350 L 795 284" fill="none" className={`${LINE} flow`} strokeWidth="1.6" markerEnd="url(#arrow)" />
          <text x="400" y="342" textAnchor="middle" className={`${SUB} text-[10px]`}>plain USDC transfer</text>
          <text x="400" y="366" textAnchor="middle" className={`${SUB} text-[10px]`}>no permission exists, and none can</text>

          {/* ---------------------------------------------------------- worker */}
          <rect x="14" y="398" width="892" height="86" rx={10} className={`${BOX} ${EDGE}`} strokeWidth="1" />
          <text x="30" y="420" className={`${TITLE} text-[12px] font-semibold`}>Retainer worker</text>
          <text x="30" y="437" className={`${SUB} text-[11px]`}>holds no funds on either path — it signs transactions and reads the chain, never custodies</text>
          <text x="30" y="455" className={`${SUB} text-[11px]`}>charger → classifies before spending gas, then calls spendAndRoute()   ·   reconciler → sole writer of confirmed</text>
          <text x="30" y="472" className={`${SUB} text-[11px]`}>watcher → indexes transfers at 3 confirmations   ·   matcher → attributes, or defers to review   ·   sweep → overdue + alerts</text>

          {/* worker -> router: the executor is the only caller the router accepts */}
          <line x1="520" y1="398" x2="520" y2="182" className={LINE} strokeWidth="1.2" strokeDasharray="3 4" markerEnd="url(#arrow)" />
          <text x="526" y="300" className={`${SUB} text-[10px]`}>spendAndRoute()</text>

          {/* worker watches the treasury's incoming transfers */}
          <line x1="660" y1="398" x2="660" y2="354" className={LINE} strokeWidth="1.2" strokeDasharray="3 4" markerEnd="url(#arrow)" />
          <text x="666" y="384" className={`${SUB} text-[10px]`}>watches</text>
        </svg>
      </div>
      {caption && <figcaption className="mt-2 text-center text-xs text-neutral-500 dark:text-neutral-400">{caption}</figcaption>}
    </figure>
  );
}
