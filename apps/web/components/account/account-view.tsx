"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createWalletClient, custom, encodeFunctionData, getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { erc20Abi, signInTypedData, smartWalletAbi, spendPermissionManagerAbi, toStruct } from "@retainer/chain";
import {
  CHAIN_HEX, FAUCETS, Link2, Row, errorBox, notice, periodWords, primary, pub, scan, secondary, short, switchNetwork,
  useInjectedWallets, usdc, when, type Announced, type Eip1193,
} from "@/components/sign/ui";

/**
 * A customer's own permissions: what each allows, what has been taken under it, and the
 * controls to fund, withdraw and cancel.
 *
 * Nothing is shown until the connected wallet has signed in, and data is only ever shown
 * while the signed-in address IS the connected wallet: switch accounts in the wallet and the
 * page clears at once and asks that account to sign in. The server enforces the same rule
 * independently -- it reads the address from the session cookie, never from the page.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Charge = { id: string; amount: string; state: string; failure: string | null; txHash: Hex | null; at: string };
type Perm = {
  id: string; permissionHash: Hex; account: Hex; recipient: Hex; merchantName: string | null; spender: Hex; token: Hex; allowance: string; period: number;
  start: number; end: number; salt: string; extraData: Hex; state: "active" | "revoked" | "expired" | "not_started";
  revokedOnChain: boolean | null; revokeRecorded: boolean; approveTx: Hex | null; revokeTx: Hex | null;
  thisPeriod: { start: number; end: number; spent: string; remaining: string } | null; accountBalance: string | null; charges: Charge[];
};
type Policy = { chainId: number; manager: Hex; usdc: Hex; treasury: Hex };

const CHARGE_WORDS: Record<string, string> = {
  confirmed: "Taken", pending: "Scheduled", in_flight: "Sending",
  failed_retryable: "Not taken yet — will retry", failed_deferred: "Not taken yet — will retry", failed_terminal: "Not taken",
};
const FAILURE_WORDS: Record<string, string> = {
  INSUFFICIENT_BALANCE: "your smart account did not hold enough USDC", ALLOWANCE_EXHAUSTED: "that period's cap was already used",
  REVOKED: "the permission had been revoked", EXPIRED: "the permission had expired", NOT_STARTED: "the permission had not started yet",
  NOT_APPROVED: "the permission was not registered on-chain", UNKNOWN: "an unexpected error",
};
const STATE_BADGE: Record<Perm["state"], { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300" },
  revoked: { label: "Revoked", cls: "bg-neutral-500/10 text-neutral-600 ring-neutral-500/30 dark:text-neutral-300" },
  expired: { label: "Expired", cls: "bg-neutral-500/10 text-neutral-600 ring-neutral-500/30 dark:text-neutral-300" },
  not_started: { label: "Not started", cls: "bg-amber-500/10 text-amber-700 ring-amber-500/30 dark:text-amber-300" },
};
const card = "rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10";

export function AccountView() {
  const wallets = useInjectedWallets();
  const [pol, setPol] = useState<Policy | null>(null);
  const [provider, setProvider] = useState<Eip1193 | null>(null);
  const [walletName, setWalletName] = useState("");
  const [eoa, setEoa] = useState<Hex | null>(null);
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [session, setSession] = useState<string | null | undefined>(undefined);   // undefined: not yet asked
  const [perms, setPerms] = useState<Perm[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [needEth, setNeedEth] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => { fetch("/api/permissions").then((r) => r.json()).then(setPol).catch(() => setErr("Could not reach Retainer.")); }, []);
  useEffect(() => { fetch("/api/session").then((r) => r.json()).then((j) => setSession(j.address ?? null)).catch(() => setSession(null)); }, []);

  const wc = useMemo(() => (provider && eoa ? createWalletClient({ account: eoa, chain: baseSepolia, transport: custom(provider) }) : null), [provider, eoa]);
  const signedInHere = !!eoa && !!session && session === eoa.toLowerCase();

  const load = useCallback(async () => {
    const r = await fetch("/api/me/permissions");
    if (r.status === 401) { setSession(null); setPerms(null); return; }
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? "Could not load your permissions."); return; }
    setPerms(j.permissions);
  }, []);
  useEffect(() => { if (signedInHere) load(); else setPerms(null); }, [signedInHere, load]);

  const useAccount = useCallback(async (p: Eip1193, addr: string) => {
    setEoa(getAddress(addr) as Hex); setPerms(null); setErr(null); setConfirming(null);
    setChainOk((await p.request({ method: "eth_chainId" })) === CHAIN_HEX);
  }, []);

  async function connect(w: Announced) {
    setErr(null); setBusy("Connecting…");
    try {
      setProvider(w.provider); setWalletName(w.info.name);
      const [addr] = await w.provider.request({ method: "eth_requestAccounts" });
      await useAccount(w.provider, addr);
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(null); }
  }

  // The page always describes the account the wallet has selected right now.
  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (a: string[]) => { if (a?.[0]) useAccount(provider, a[0]); else { setEoa(null); setPerms(null); } };
    const onChain = (id: string) => setChainOk(id === CHAIN_HEX);
    provider.on("accountsChanged", onAccounts); provider.on("chainChanged", onChain);
    return () => { provider.removeListener?.("accountsChanged", onAccounts); provider.removeListener?.("chainChanged", onChain); };
  }, [provider, useAccount]);

  async function signIn() {
    if (!wc || !eoa) return;
    setErr(null); setBusy(`Waiting for ${walletName} — sign the message to prove this address is yours…`);
    try {
      const n = await fetch("/api/session/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: eoa }) });
      const fields = await n.json();
      if (!n.ok) throw new Error(fields.error ?? "Could not start sign-in.");
      const td = signInTypedData(fields) as any;
      const signature = await wc.signTypedData({ account: eoa, domain: td.domain, types: td.types, primaryType: "RetainerSignIn", message: td.message });
      const s = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: fields.nonce, signature }) });
      const j = await s.json();
      if (!s.ok) throw new Error(j.error ?? "Sign-in was refused.");
      setSession(j.address.toLowerCase());
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(null); }
  }

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    setSession(null); setPerms(null);
  }

  /** Run one wallet transaction, then refresh from the server. */
  async function act(label: string, fn: () => Promise<Hex>, after?: (tx: Hex) => Promise<void>) {
    setErr(null); setNeedEth(false); setBusy(label);
    try {
      const tx = await fn();
      setBusy("Waiting for it to confirm on Base Sepolia…");
      await pub.waitForTransactionReceipt({ hash: tx });
      if (after) await after(tx);
      await load();
    } catch (e: any) { const m = e?.shortMessage ?? e?.message ?? String(e); setErr(m); setNeedEth(/insufficient funds|gas/i.test(m)); }
    finally { setBusy(null); setConfirming(null); }
  }

  /** Ask the server to verify and record a revoke. Early reads are retried; a real refusal is returned as-is. */
  async function recordRevoke(permissionHash: string, txHash: string): Promise<string | null> {
    let error = "";
    for (let i = 0; i < 3; i++) {
      const r = await fetch("/api/permissions/revoke", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionHash, txHash }) }).catch(() => null);
      const j = r ? await r.json().catch(() => ({})) : {};
      if (r?.ok) return null;
      error = j.error ?? (r ? `HTTP ${r.status}` : "network error");
      if (r && r.status < 500 && j.code !== "not_confirmed" && j.code !== "not_revoked") break;
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
    return error;
  }

  const revoke = (p: Perm) => act("Waiting for your wallet — revoking costs a little testnet ETH…", () => {
    const s = toStruct(p);
    // The manager only accepts revoke() from the account itself, and the account accepts execute()
    // from its owner -- so the customer's wallet calls account.execute(manager, revoke).
    return wc!.writeContract({ address: s.account, abi: smartWalletAbi, functionName: "execute", account: eoa!, chain: baseSepolia,
      args: [pol!.manager, 0n, encodeFunctionData({ abi: spendPermissionManagerAbi, functionName: "revoke", args: [s] })] });
  }, async (tx) => {
    const refused = await recordRevoke(p.permissionHash, tx);
    if (refused) setErr(`Revoked on-chain in ${short(tx)} — the contract enforces it. Retainer has not recorded it yet (${refused}); reload this page to try again.`);
  });
  const fund = (p: Perm) => act("Waiting for your wallet to send USDC to your smart account…", () =>
    wc!.writeContract({ address: pol!.usdc, abi: erc20Abi, functionName: "transfer", args: [p.account, BigInt(p.allowance)], account: eoa!, chain: baseSepolia }));
  const withdraw = (p: Perm) => act("Waiting for your wallet to move the balance back to it…", () =>
    wc!.writeContract({ address: p.account, abi: smartWalletAbi, functionName: "execute", account: eoa!, chain: baseSepolia,
      args: [pol!.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [eoa!, BigInt(p.accountBalance!)] })] }));

  const switchBtn = chainOk === false && (
    <button className={`${secondary} !px-2.5 !py-1 text-xs`} disabled={!!busy} onClick={async () => setChainOk(await switchNetwork(provider!).catch(() => false))}>Switch to Base Sepolia</button>
  );

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------ who you are */}
      <section className={card}>
        {!eoa ? (
          <>
            <p className="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
              Connect the wallet you used when you authorised a payment. Permissions belong to the wallet that signed them.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {wallets.map((w) => (
                <button key={w.info.uuid} className={secondary} disabled={!!busy} onClick={() => connect(w)}>
                  {w.info.icon && <img src={w.info.icon} alt="" className="mr-2 inline size-4 align-[-3px]" />}{w.info.name}
                </button>
              ))}
              {wallets.length === 0 && <p className="text-xs text-neutral-500 dark:text-neutral-400">No browser wallet detected. <Link2 href="https://metamask.io/download/">Install MetaMask</Link2> or another wallet extension, then reload.</p>}
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Connected account in {walletName}</div>
              <div className="mt-0.5 break-all font-mono text-sm font-semibold text-neutral-900 dark:text-white">{eoa}</div>
              <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                {signedInHere ? "Signed in" : "Not signed in"}{chainOk === false && <> · not on Base Sepolia {switchBtn}</>}
              </div>
            </div>
            {signedInHere && <button className="text-xs text-neutral-500 underline" onClick={signOut}>Sign out</button>}
          </div>
        )}

        {eoa && !signedInHere && (
          <div className="mt-4 border-t border-neutral-100 pt-4 dark:border-white/5">
            {session && session !== eoa.toLowerCase() && (
              <p className={`${notice} mb-3`}>
                This browser is signed in as <span className="font-mono">{short(session)}</span>, but {walletName} now has{" "}
                <span className="font-mono">{short(eoa)}</span> selected. Nothing from the other account is shown here. Sign in as this one to see its permissions.
              </p>
            )}
            <p className="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
              To show you your permissions, Retainer needs to know this address is yours. {walletName} will ask you to sign a message titled
              {" "}<b>&ldquo;Retainer Sign-In&rdquo;</b>. It <b>costs nothing, sends no transaction and authorises no payment</b> — it only proves you
              control this address. You stay signed in for 12 hours on this browser.
            </p>
            <button className={`${primary} mt-4`} disabled={!!busy} onClick={signIn}>Sign in with {walletName}</button>
          </div>
        )}
      </section>

      {busy && <p className="text-sm text-neutral-600 dark:text-neutral-400">{busy}</p>}
      {err && <p className={errorBox}>{err}{needEth && <> Your wallet needs a little Base Sepolia ETH for this — <Link2 href={FAUCETS}>faucets</Link2>.</>}</p>}

      {/* ------------------------------------------------ your permissions */}
      {signedInHere && perms === null && <p className="text-sm text-neutral-500">Loading your permissions…</p>}
      {signedInHere && perms?.length === 0 && (
        <section className={card}>
          <p className="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            <b>No permissions for {short(eoa)}.</b> If you authorised a payment with a different account, switch to it in {walletName}.
          </p>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Payments are set up from the link your merchant sends. To see how it works, <Link href="/try" className="text-brand-primary hover:underline">try the demo →</Link></p>
        </section>
      )}
      {signedInHere && perms?.map((p) => {
        const badge = STATE_BADGE[p.state];
        const per = periodWords(p.period);
        const spent = p.thisPeriod ? BigInt(p.thisPeriod.spent) : null;
        const pct = spent !== null ? Math.min(100, Number((spent * 100n) / BigInt(p.allowance))) : 0;
        const bal = p.accountBalance === null ? null : BigInt(p.accountBalance);
        const canAct = !busy && chainOk === true;
        return (
          <article key={p.id} className={card} data-permission={p.id}>
            <header className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-neutral-900 dark:text-white">
                Permission #{p.id} <span className="font-normal text-neutral-500">· {p.merchantName ? <>billed by {p.merchantName} · </> : null}pays <span className="font-mono">{short(p.recipient)}</span>{!p.merchantName && pol && p.recipient.toLowerCase() === pol.treasury.toLowerCase() ? " (Retainer demo merchant)" : ""}</span>
              </h2>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${badge.cls}`}>{badge.label}</span>
            </header>

            <p className="mt-3 text-base leading-7 text-neutral-900 dark:text-white">At most <b>{usdc(p.allowance)} USDC in any {per}</b>.</p>

            {p.state === "active" && (p.thisPeriod ? (
              <div className="mt-3">
                <div className="h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full rounded-full bg-neutral-900 dark:bg-white" style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                  {usdc(p.thisPeriod.spent)} of {usdc(p.allowance)} USDC taken this {per} · {usdc(p.thisPeriod.remaining)} can still be taken · resets {when(p.thisPeriod.end)}
                </p>
              </div>
            ) : <p className="mt-3 text-xs text-neutral-500">This {per}&apos;s usage is unavailable right now — the chain could not be reached.</p>)}
            {p.state === "revoked" && (
              <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
                Revoked{p.revokeTx && <> in <Link2 href={scan("tx", p.revokeTx)}>{short(p.revokeTx)}</Link2></>} — nothing more can be taken under it.
                {!p.revokeRecorded && " (Revoked on-chain; Retainer's record has not caught up yet.)"}
              </p>
            )}
            {p.state === "expired" && <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">Expired {when(p.end)} — it can never be used again.</p>}

            <div className="mt-4">
              <Row k="Started">{when(p.start)}</Row>
              <Row k="Expires">{when(p.end)}</Row>
              <Row k="Smart account">
                <Link2 href={scan("address", p.account)}>{short(p.account)}</Link2> · {bal === null ? "balance unavailable" : `${usdc(bal)} USDC`}
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">Yours. Every permission this wallet signed draws from it; nothing else can move money out of it except you.</span>
              </Row>
              <Row k="Fingerprint"><span className="font-mono">{short(p.permissionHash)}</span>{p.approveTx && <> · <Link2 href={scan("tx", p.approveTx)}>registration</Link2></>}</Row>
            </div>

            {/* charges taken under it */}
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Charges</h3>
            {p.charges.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">None yet. The merchant decides when to bill; each charge appears here with its transaction.</p>
            ) : (
              <ul className="mt-2 divide-y divide-neutral-100 dark:divide-white/5">
                {p.charges.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm">
                    <span className="font-mono text-neutral-900 dark:text-white">{usdc(c.amount)} USDC</span>
                    <span className="text-neutral-600 dark:text-neutral-400">
                      {CHARGE_WORDS[c.state] ?? c.state}{c.state !== "confirmed" && c.failure && <> — {FAILURE_WORDS[c.failure] ?? c.failure.toLowerCase()}</>}
                    </span>
                    <span className="text-xs text-neutral-500">{c.at.replace("T", " ").slice(0, 16)} UTC{c.txHash && <> · <Link2 href={scan("tx", c.txHash)}>Basescan</Link2></>}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* controls */}
            {(p.state === "active" || (bal !== null && bal > 0n)) && (
              <div className="mt-5 flex flex-wrap gap-2 border-t border-neutral-100 pt-4 dark:border-white/5">
                {p.state === "active" && bal !== null && bal < BigInt(p.allowance) && (
                  <button className={secondary} disabled={!canAct} onClick={() => fund(p)}>Add {usdc(p.allowance)} USDC</button>
                )}
                {bal !== null && bal > 0n && (
                  <button className={secondary} disabled={!canAct} onClick={() => withdraw(p)}>Withdraw {usdc(bal)} USDC</button>
                )}
                {p.state === "active" && confirming !== p.id && (
                  <button className={secondary} disabled={!canAct} onClick={() => setConfirming(p.id)}>Revoke…</button>
                )}
              </div>
            )}
            {confirming === p.id && (
              <div className={`${notice} mt-3`}>
                <b>Revoke permission #{p.id}?</b> No further charges can be taken under it, ever. It is one transaction from {walletName} and
                needs a little Base Sepolia ETH. Charges already taken stay taken, and the USDC in your smart account stays yours.
                <div className="mt-3 flex flex-wrap gap-2">
                  <button className={primary} disabled={!canAct} onClick={() => revoke(p)}>Revoke permission</button>
                  <button className={secondary} disabled={!!busy} onClick={() => setConfirming(null)}>Keep it</button>
                </div>
              </div>
            )}
          </article>
        );
      })}

      <p className="text-xs leading-5 text-neutral-500 dark:text-neutral-400" data-caveat>
        Signing in proves this address is yours, so Retainer only ever shows you your own permissions. It does not make them private:
        permissions and charges are recorded on a public blockchain, and anyone can look up an address on Basescan.
      </p>
    </div>
  );
}
