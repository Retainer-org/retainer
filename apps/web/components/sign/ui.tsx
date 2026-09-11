"use client";

import { useEffect, useState } from "react";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * The pieces the customer pages share: the sign page and the account page are one product,
 * so they read and behave alike -- same cards, same checks, same wallet handling.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { ethereum?: any } }
export type Eip1193 = { request: (a: { method: string; params?: unknown[] | object }) => Promise<any>; on?: any; removeListener?: any };
export type Announced = { info: { uuid: string; name: string; icon?: string; rdns: string }; provider: Eip1193 };

export const CHAIN_HEX = "0x14a34"; // 84532
export const FAUCETS = "https://docs.base.org/get-started/get-funds";
export const pub = createPublicClient({ chain: baseSepolia, transport: http() });

/** Ask the wallet for Base Sepolia, adding the network if it does not know it. Returns whether it is now on it. */
export async function switchNetwork(p: Eip1193): Promise<boolean> {
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e: any) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [{
      chainId: CHAIN_HEX, chainName: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
  }
  return (await p.request({ method: "eth_chainId" })) === CHAIN_HEX;
}

/** EIP-6963: every injected wallet announces itself; window.ethereum is the fallback. */
export function useInjectedWallets(): Announced[] {
  const [wallets, setWallets] = useState<Announced[]>([]);
  useEffect(() => {
    const seen = new Map<string, Announced>();
    const onAnnounce = (e: any) => { seen.set(e.detail.info.rdns, e.detail); setWallets([...seen.values()]); };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const t = setTimeout(() => {
      if (seen.size === 0 && window.ethereum) {
        seen.set("injected", { info: { uuid: "injected", name: "Browser wallet", rdns: "injected" }, provider: window.ethereum });
        setWallets([...seen.values()]);
      }
    }, 400);
    return () => { window.removeEventListener("eip6963:announceProvider", onAnnounce); clearTimeout(t); };
  }, []);
  return wallets;
}

/* ------------------------------------------------------------------ formatting */
export const usdc = (v: bigint | string, dp = 2) => (Number(BigInt(v)) / 1e6).toFixed(dp);
export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const when = (unix: number) => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
export const periodWords = (s: number) =>
  s % 86400 === 0 ? (s === 86400 ? "day" : `${s / 86400}-day period`) : s % 3600 === 0 ? `${s / 3600}-hour period` : `${s}-second period`;
export const scan = (kind: "address" | "tx", v: string) => `https://sepolia.basescan.org/${kind}/${v}`;

export function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 border-t border-neutral-100 py-2.5 text-sm first:border-t-0 dark:border-white/5">
      <div className="text-neutral-500 dark:text-neutral-400">{k}</div>
      <div className="min-w-0 break-words text-neutral-900 dark:text-neutral-100">{children}</div>
    </div>
  );
}
export function Link2({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{children}</a>;
}
export function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-white">
        <span className={`flex size-6 items-center justify-center rounded-full font-mono text-xs ${done ? "bg-emerald-600 text-white" : "bg-neutral-900 text-white dark:bg-white dark:text-black"}`}>{done ? "✓" : n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}
export function Check({ ok, pending, children }: { ok: boolean; pending?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`mt-0.5 font-mono text-xs ${pending ? "text-neutral-400" : ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{pending ? "…" : ok ? "✓" : "✗"}</span>
      <span className="text-neutral-700 dark:text-neutral-300">{children}</span>
    </li>
  );
}
export const btn = "rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";
export const primary = `${btn} bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200`;
export const secondary = `${btn} ring-1 ring-neutral-300 text-neutral-800 hover:bg-neutral-50 dark:ring-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800`;
export const notice = "rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200";
export const errorBox = "rounded-lg bg-red-500/10 p-3 text-sm text-red-700 ring-1 ring-red-500/30 dark:text-red-300";
