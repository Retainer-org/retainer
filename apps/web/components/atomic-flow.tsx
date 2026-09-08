"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The product's central claim, drawn rather than described:
 * customer → router → merchant in one transaction, and the router's balance
 * returns to zero every time.
 *
 * Honesty constraints, all met:
 * - The six amounts are the six confirmed drill charges, in order, from the
 *   README. Nothing is invented. The merchant ends at 7.05 USDC, which is the
 *   treasury's real on-chain balance; the customer starts at the 20 USDC the
 *   faucet supplied and ends at 12.95.
 * - Pure inline SVG + CSS keyframes. No animation library, no image fetch, so
 *   nothing competes with the hero text for LCP. The SVG shell is server-rendered;
 *   JS only advances the balance labels between loops.
 * - prefers-reduced-motion: the packet does not move and the balances hold the
 *   final, real state. The flow still reads from the arrows and the "→ 0" mark.
 * - Colours come from the theme tokens (currentColor + --color-brand-primary),
 *   so both palettes are the same component.
 */

// Six confirmed charges, base units (USDC, 6 dp). Order and values from README.
const CHARGES = [
  { id: 1, amount: 1_000_000, kind: "fixed" },
  { id: 8, amount: 1_500_000, kind: "fixed" },
  { id: 9, amount: 1_250_000, kind: "usage" },
  { id: 10, amount: 1_100_000, kind: "fixed" },
  { id: 11, amount: 1_300_000, kind: "fixed" },
  { id: 12, amount: 900_000, kind: "fixed" },
] as const;

const CUSTOMER_START = 20_000_000; // faucet USDC moved into the test wallet
const TOTAL = CHARGES.reduce((s, c) => s + c.amount, 0); // 7,050,000 = live treasury
const CYCLE_MS = 2600; // one charge per cycle; ~3s to read the first pass

const usd = (n: number) => (n / 1_000_000).toFixed(2);

export function AtomicFlow() {
  const [i, setI] = useState(0);
  const [reduced, setReduced] = useState(false);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Advance the balance labels once per animation cycle. Timing is tied to the
  // CSS animation duration so the labels change when the packet lands.
  useEffect(() => {
    if (reduced) return;
    let start = performance.now();
    const tick = (t: number) => {
      if (t - start >= CYCLE_MS) {
        start = t;
        setI((v) => (v + 1) % CHARGES.length);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [reduced]);

  // Balances *before* the current charge lands; after it lands, the labels
  // advance on the next tick. In reduced-motion, show the completed state.
  const settledSoFar = reduced ? TOTAL : CHARGES.slice(0, i).reduce((s, c) => s + c.amount, 0);
  const current = CHARGES[i];
  const customer = CUSTOMER_START - settledSoFar;
  const merchant = settledSoFar;

  return (
    <figure
      aria-label="A charge moves from the customer through Retainer's router to the merchant in one transaction; the router's balance returns to zero after each one."
      className="atomic-flow relative mx-auto w-full max-w-3xl select-none"
      data-reduced={reduced ? "true" : "false"}
    >
      <style>{`
        .atomic-flow .packet { offset-path: path('M 72 88 L 300 88 L 528 88'); offset-distance: 0%; animation: af-move ${CYCLE_MS}ms cubic-bezier(.4,0,.2,1) infinite; }
        .atomic-flow .router-amt { animation: af-router ${CYCLE_MS}ms linear infinite; }
        .atomic-flow .zero { animation: af-zero ${CYCLE_MS}ms linear infinite; }
        @keyframes af-move {
          0%   { offset-distance: 0%;   opacity: 0; }
          6%   { opacity: 1; }
          46%  { offset-distance: 50%; }
          54%  { offset-distance: 50%; }
          92%  { offset-distance: 100%; opacity: 1; }
          100% { offset-distance: 100%; opacity: 0; }
        }
        /* router shows the amount only while the packet is inside it, then 0 */
        @keyframes af-router { 0%,45% { opacity: 0 } 47%,53% { opacity: 1 } 56%,100% { opacity: 0 } }
        @keyframes af-zero   { 0%,45% { opacity: 1 } 47%,53% { opacity: 0 } 56%,100% { opacity: 1 } }
        @media (prefers-reduced-motion: reduce) {
          .atomic-flow .packet, .atomic-flow .router-amt, .atomic-flow .zero { animation: none; }
          .atomic-flow .packet { offset-distance: 100%; opacity: 0; }
          .atomic-flow .router-amt { opacity: 0; } .atomic-flow .zero { opacity: 1; }
        }
      `}</style>

      <svg viewBox="0 0 600 176" className="h-auto w-full text-neutral-700 dark:text-neutral-300" role="img">
        {/* rails */}
        <line x1="112" y1="88" x2="260" y2="88" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" strokeDasharray="4 6" />
        <line x1="340" y1="88" x2="488" y2="88" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" strokeDasharray="4 6" />
        <polygon points="256,83 266,88 256,93" fill="currentColor" fillOpacity=".4" />
        <polygon points="484,83 494,88 484,93" fill="currentColor" fillOpacity=".4" />

        {/* customer */}
        <Node x={72} label="Customer" sub="Base Account">
          <text x="72" y="98" textAnchor="middle" className="fill-current font-mono text-[15px]">{usd(customer)}</text>
        </Node>

        {/* router */}
        <Node x={300} label="Retainer router" sub="one atomic transaction" accent>
          <text x="300" y="98" textAnchor="middle" className="router-amt fill-current font-mono text-[15px]">{usd(current.amount)}</text>
          <text x="300" y="98" textAnchor="middle" className="zero fill-current font-mono text-[15px]">0.00</text>
        </Node>

        {/* merchant */}
        <Node x={528} label="Merchant treasury" sub="0x47dB…6A67">
          <text x="528" y="98" textAnchor="middle" className="fill-current font-mono text-[15px]">{usd(merchant)}</text>
        </Node>

        {/* the charge in flight */}
        <g className="packet">
          <rect x="-26" y="-11" width="52" height="22" rx="11" fill="var(--color-brand-primary)" />
          <text x="0" y="4" textAnchor="middle" className="font-mono text-[11px] font-medium" fill="white">{usd(current.amount)}</text>
        </g>

        {/* caption row: what this cycle is */}
        <text x="300" y="164" textAnchor="middle" className="fill-current font-mono text-[10.5px]" fillOpacity=".7">
          {reduced
            ? `6 charges · 7.05 USDC settled · router balance after each: 0`
            : `charge ${current.id} · ${current.kind === "usage" ? "usage, computed at charge time" : "fixed"} · router balance after: 0`}
        </text>
      </svg>
      <figcaption className="sr-only">
        Six real charges from the test drills, totalling 7.05 USDC, each settled to the merchant treasury with the router holding nothing afterwards.
      </figcaption>
    </figure>
  );
}

function Node({ x, label, sub, accent, children }: { x: number; label: string; sub: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <g>
      <rect x={x - 40} y="60" width="80" height="56" rx="12"
        fill="var(--color-card, transparent)" stroke={accent ? "var(--color-brand-primary)" : "currentColor"}
        strokeOpacity={accent ? 0.9 : 0.35} strokeWidth={accent ? 1.5 : 1} />
      {children}
      <text x={x} y="40" textAnchor="middle" className="fill-current text-[12px] font-medium">{label}</text>
      <text x={x} y="136" textAnchor="middle" className="fill-current text-[10px]" fillOpacity=".6">{sub}</text>
    </g>
  );
}
