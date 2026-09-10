"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient, createWalletClient, custom, encodeFunctionData, getAddress, http, type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import {
  classifyOwnerCode, deriveSmartAccount, erc20Abi, localPermissionHash, managerDomain,
  smartWalletAbi, smartWalletTypedData, spendPermissionManagerAbi, toStruct,
} from "@retainer/chain";

/**
 * Sign a spend permission with any injected wallet (MetaMask, Rabby, ...) or a Base Account.
 *
 * The injected path exists because Coinbase's hosted consent screen refuses new Base
 * Accounts on Base Sepolia (base/account-sdk#363). It has one weakness Coinbase's screen
 * does not: MetaMask shows only an opaque 32-byte hash, not the terms. So this page is
 * the customer's whole understanding of what they sign, and it is built around that:
 *
 *   - the terms come first, in plain language, before any wallet is touched;
 *   - every number shown is rendered from the exact struct that gets hashed;
 *   - the button stays disabled until the hash computed here equals the manager's
 *     getHash() on-chain, and the same hash is shown as the fingerprint the wallet
 *     will display -- turning a blind signature into one the customer can check;
 *   - owner code is read from the chain before anything is signed, so a 7702-upgraded
 *     account is told plainly instead of signing into a failure;
 *   - funding is its own explicit step, because charges draw from a smart account the
 *     customer has never seen, and it starts empty.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { ethereum?: any } }
type Eip1193 = { request: (a: { method: string; params?: unknown[] | object }) => Promise<any>; on?: any; removeListener?: any };
type Announced = { info: { uuid: string; name: string; icon?: string; rdns: string }; provider: Eip1193 };

type Policy = {
  chainId: number; manager: Hex; router: Hex; usdc: Hex; executor: Hex; treasury: Hex; factory: Hex; extraData: Hex;
  allowance: string; periodSeconds: number; periodInDays: number; durationSeconds: number;
};
type Struct = ReturnType<typeof toStruct>;
type Existing = { id: string; permissionHash: Hex; approveTx: Hex | null; revokedAt: string | null; revokeTx: Hex | null; permission: any };

const CHAIN_HEX = "0x14a34"; // 84532
const pub = createPublicClient({ chain: baseSepolia, transport: http() });

/** Ask the wallet for Base Sepolia, adding the network if it does not know it. Returns whether it is now on it. */
async function switchNetwork(p: Eip1193): Promise<boolean> {
  try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX }] }); }
  catch (e: any) {
    if (e?.code !== 4902 && e?.data?.originalError?.code !== 4902) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [{
      chainId: CHAIN_HEX, chainName: "Base Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: ["https://sepolia.base.org"], blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
  }
  return (await p.request({ method: "eth_chainId" })) === CHAIN_HEX;
}

/* ------------------------------------------------------------------ formatting */
const usdc = (v: bigint | string, dp = 2) => (Number(BigInt(v)) / 1e6).toFixed(dp);
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const when = (unix: number) => new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const periodWords = (s: number) =>
  s % 86400 === 0 ? (s === 86400 ? "day" : `${s / 86400}-day period`) : s % 3600 === 0 ? `${s / 3600}-hour period` : `${s}-second period`;
const scan = (kind: "address" | "tx", v: string) => `https://sepolia.basescan.org/${kind}/${v}`;
const randomSalt = () => {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
};

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 border-t border-neutral-100 py-2.5 text-sm first:border-t-0 dark:border-white/5">
      <div className="text-neutral-500 dark:text-neutral-400">{k}</div>
      <div className="min-w-0 break-words text-neutral-900 dark:text-neutral-100">{children}</div>
    </div>
  );
}
function Link2({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-primary hover:underline">{children}</a>;
}
function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
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
function Check({ ok, pending, children }: { ok: boolean; pending?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span className={`mt-0.5 font-mono text-xs ${pending ? "text-neutral-400" : ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{pending ? "…" : ok ? "✓" : "✗"}</span>
      <span className="text-neutral-700 dark:text-neutral-300">{children}</span>
    </li>
  );
}
const btn = "rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40";
const primary = `${btn} bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-white dark:text-black dark:hover:bg-neutral-200`;
const secondary = `${btn} ring-1 ring-neutral-300 text-neutral-800 hover:bg-neutral-50 dark:ring-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800`;

/* ======================================================================= */
export function SignFlow() {
  const [pol, setPol] = useState<Policy | null>(null);
  const [wallets, setWallets] = useState<Announced[]>([]);
  const [provider, setProvider] = useState<Eip1193 | null>(null);
  const [walletName, setWalletName] = useState("");
  const [eoa, setEoa] = useState<Hex | null>(null);
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [owner, setOwner] = useState<ReturnType<typeof classifyOwnerCode> | null>(null);
  const [account, setAccount] = useState<Hex | null>(null);
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [struct, setStruct] = useState<Struct | null>(null);
  const [hash, setHash] = useState<{ local: Hex; onchain: Hex } | null>(null);
  const [ackUnfunded, setAckUnfunded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [fundTx, setFundTx] = useState<Hex | null>(null);
  const [existing, setExisting] = useState<Existing[]>([]);
  const [revoked, setRevoked] = useState<Record<string, Hex>>({});
  const baseSdk = useRef<any>(null);

  useEffect(() => { fetch("/api/permissions").then((r) => r.json()).then(setPol).catch(() => setErr("Could not load the terms this deployment offers.")); }, []);

  // EIP-6963: every injected wallet announces itself; window.ethereum is the fallback.
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

  const allowance = pol ? BigInt(pol.allowance) : 0n;
  const wc = useMemo(() => (provider && eoa ? createWalletClient({ account: eoa, chain: baseSepolia, transport: custom(provider) }) : null), [provider, eoa]);

  const reset = () => {
    setEoa(null); setOwner(null); setAccount(null); setDeployed(null); setBalance(null); setStruct(null);
    setHash(null); setResult(null); setErr(null); setAckUnfunded(false); setFundTx(null); setExisting([]); setChainOk(null);
  };

  /* ---------------------------------------------------------- connect + preflight */
  const connect = useCallback(async (w: Announced) => {
    if (!pol) return;
    reset(); setErr(null); setBusy("Connecting…");
    try {
      setProvider(w.provider); setWalletName(w.info.name);
      const [addr] = await w.provider.request({ method: "eth_requestAccounts" });
      const me = getAddress(addr);
      setEoa(me);

      // Ask the wallet to switch, but do not stop if it will not: everything below reads Base Sepolia
      // through our own client, not the wallet's. Only signing and sending need the wallet on the right
      // network, and those stay gated on this check -- with a button beside it to fix it.
      const cid = await w.provider.request({ method: "eth_chainId" });
      setChainOk(cid === CHAIN_HEX ? true : await switchNetwork(w.provider).catch(() => false));

      // Owner code from the chain -- not from anything the wallet says about itself.
      setBusy("Checking your account…");
      const kind = classifyOwnerCode(await pub.getCode({ address: me }));
      setOwner(kind);
      if (kind.kind !== "eoa") return;

      const acct = await deriveSmartAccount(pub, me, pol.manager);
      setAccount(acct);
      const code = await pub.getCode({ address: acct });
      setDeployed(!!code && code !== "0x");

      // The exact struct that will be hashed, signed and submitted. Everything on screen reads from it.
      const start = Math.floor(Date.now() / 1000);
      const s = toStruct({ account: acct, spender: pol.router, token: pol.usdc, allowance: pol.allowance,
        period: pol.periodSeconds, start, end: start + pol.durationSeconds, salt: randomSalt(), extraData: pol.extraData });
      setStruct(s);
      const [dom, onchain] = await Promise.all([
        managerDomain(pub, pol.manager),
        pub.readContract({ address: pol.manager, abi: spendPermissionManagerAbi, functionName: "getHash", args: [s] }) as Promise<Hex>,
      ]);
      setHash({ local: localPermissionHash(dom, s), onchain });

      const mine = await fetch(`/api/permissions?signer=${me}`).then((r) => r.json()).catch(() => ({ permissions: [] }));
      setExisting(mine.permissions ?? []);
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? String(e));
    } finally { setBusy(null); }
  }, [pol]);

  // Live balance of the smart account, so funding is visible the moment it lands.
  useEffect(() => {
    if (!account || !pol) return;
    let stop = false;
    const tick = async () => {
      try { const b = await pub.readContract({ address: pol.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }) as bigint; if (!stop) setBalance(b); } catch { /* keep last */ }
    };
    tick(); const id = setInterval(tick, 6000);
    return () => { stop = true; clearInterval(id); };
  }, [account, pol]);

  useEffect(() => {
    if (!provider?.on) return;
    // A different account is a different customer: start over. A different network is not --
    // everything already shown still stands, so only the network check is re-evaluated.
    const onAccounts = () => reset();
    const onChain = (id: string) => setChainOk(id === CHAIN_HEX);
    provider.on("accountsChanged", onAccounts); provider.on("chainChanged", onChain);
    return () => { provider.removeListener?.("accountsChanged", onAccounts); provider.removeListener?.("chainChanged", onChain); };
  }, [provider]);

  /* ---------------------------------------------------------------- actions */
  async function doSwitch() {
    if (!provider) return;
    setErr(null); setBusy("Waiting for your wallet to switch network…");
    try { setChainOk(await switchNetwork(provider)); }
    catch (e: any) { setErr(`Your wallet did not switch (${e?.shortMessage ?? e?.message ?? e}). Choose Base Sepolia in the wallet, then come back — this page will notice.`); }
    finally { setBusy(null); }
  }

  async function fundFromWallet() {
    if (!wc || !account || !pol || !eoa) return;
    setErr(null); setBusy("Waiting for your wallet…");
    try {
      const tx = await wc.writeContract({ address: pol.usdc, abi: erc20Abi, functionName: "transfer", args: [account, allowance], account: eoa, chain: baseSepolia });
      setFundTx(tx); setBusy("Waiting for the transfer to confirm…");
      await pub.waitForTransactionReceipt({ hash: tx });
      setBalance(await pub.readContract({ address: pol.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }) as bigint);
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(null); }
  }

  async function sign() {
    if (!wc || !account || !struct || !hash || !eoa || !pol) return;
    setErr(null); setBusy("Waiting for your signature…");
    try {
      // @retainer/chain is untyped JS, so its literal primaryType widens to string; restate the shape viem checks.
      const td = smartWalletTypedData(account, pol.chainId, hash.onchain) as unknown as {
        domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
        types: { CoinbaseSmartWalletMessage: readonly [{ name: "hash"; type: "bytes32" }] };
        primaryType: "CoinbaseSmartWalletMessage"; message: { hash: Hex };
      };
      const signature = await wc.signTypedData({ account: eoa, ...td });
      setBusy("Registering on Base Sepolia — Retainer pays the gas…");
      const res = await fetch("/api/permissions", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "eoa_owned", signerEoa: eoa, signature, permissionHash: hash.onchain,
          permission: { ...struct, allowance: struct.allowance.toString(), salt: struct.salt.toString() } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "registration failed");
      setResult(body); setDeployed(true);
      const mine = await fetch(`/api/permissions?signer=${eoa}`).then((r) => r.json()).catch(() => ({ permissions: [] }));
      setExisting(mine.permissions ?? []);
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(null); }
  }

  async function revoke(p: Existing) {
    if (!wc || !eoa || !pol) return;
    setErr(null); setBusy("Waiting for your wallet — revoking costs a little testnet ETH…");
    try {
      const s = toStruct(p.permission);
      // The manager only accepts revoke() from the account itself, and the account accepts
      // execute() from its owner -- so the customer's EOA calls account.execute(manager, revoke).
      const tx = await wc.writeContract({ address: s.account, abi: smartWalletAbi, functionName: "execute", account: eoa, chain: baseSepolia,
        args: [pol.manager, 0n, encodeFunctionData({ abi: spendPermissionManagerAbi, functionName: "revoke", args: [s] })] });
      setBusy("Waiting for the revocation to confirm…");
      await pub.waitForTransactionReceipt({ hash: tx });
      await fetch("/api/permissions/revoke", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissionHash: p.permissionHash, txHash: tx }) });
      setRevoked((r) => ({ ...r, [p.permissionHash]: tx }));
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(null); }
  }

  async function useBaseAccount() {
    if (!pol) return;
    reset(); setErr(null); setBusy("Opening Base Account…");
    try {
      const [{ createBaseAccountSDK }, { requestSpendPermission }] = await Promise.all([
        import("@base-org/account/browser"), import("@base-org/account/spend-permission/browser")]);
      baseSdk.current ??= createBaseAccountSDK({ appName: "Retainer", appChainIds: [pol.chainId] });
      const bp = baseSdk.current.getProvider();
      const [acct] = await bp.request({ method: "eth_requestAccounts" });
      const start = Math.floor(Date.now() / 1000);
      setBusy("Review and sign in the Base Account window…");
      const sp = await requestSpendPermission({
        account: acct, spender: pol.router, token: pol.usdc, chainId: pol.chainId, allowance: BigInt(pol.allowance),
        periodInDays: pol.periodInDays, start: new Date(start * 1000), end: new Date((start + pol.durationSeconds) * 1000),
        extraData: pol.extraData, provider: bp,
      });
      setBusy("Registering on Base Sepolia — Retainer pays the gas…");
      const res = await fetch("/api/permissions", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "base_account", permission: sp.permission, signature: sp.signature, permissionHash: sp.permissionHash },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "registration failed");
      setResult(body);
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); }
    finally { setBusy(null); }
  }

  /* ---------------------------------------------------------------- gating */
  const hashOk = !!hash && hash.local.toLowerCase() === hash.onchain.toLowerCase();
  const funded = balance !== null && balance >= allowance;
  const canSign = !!struct && hashOk && owner?.kind === "eoa" && chainOk === true && (funded || ackUnfunded) && !busy && !result;

  if (!pol) return <p className="text-sm text-neutral-500">{err ?? "Loading the terms…"}</p>;
  const switchBtn = chainOk === false && (
    <button className={`${secondary} ml-3 !px-2.5 !py-1 text-xs`} disabled={!!busy} onClick={doSwitch}>Switch to Base Sepolia</button>
  );
  const periodW = periodWords(pol.periodSeconds);
  const days = pol.durationSeconds / 86400;

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------ 1. the terms, first */}
      <Step n={1} title="What you are agreeing to">
        <p className="text-base leading-7 text-neutral-900 dark:text-white">
          Retainer can collect <b>at most {usdc(allowance)} USDC in any {periodW}</b> from your account, for {days} days.
          It cannot take more, and unused allowance does not carry over to the next {periodW}.
        </p>
        <div className="mt-4">
          <Row k="Token">USDC · <Link2 href={scan("address", pol.usdc)}>{short(pol.usdc)}</Link2> on Base Sepolia</Row>
          <Row k="Exact cap">{usdc(allowance, 6)} USDC ({allowance.toString()} base units) per {periodW}</Row>
          <Row k="Starts">{struct ? when(struct.start) : "when you sign"}</Row>
          <Row k="Expires">{struct ? when(struct.end) : `${days} days after you sign`} — after that it can never be used again</Row>
          <Row k="Collected by">Retainer&apos;s SpendRouter <Link2 href={`${scan("address", pol.router)}#code`}>{short(pol.router)}</Link2> (verified source), which forwards the full amount in the same transaction and keeps none of it</Row>
          <Row k="Paid to">Merchant treasury <Link2 href={scan("address", pol.treasury)}>{short(pol.treasury)}</Link2></Row>
          <Row k="To stop it">Revoke from this page at any time by connecting the same wallet: one transaction, which costs a little testnet ETH. The merchant can also revoke it. Either way it is enforced by the contract, not by us.</Row>
        </div>
      </Step>

      {/* ------------------------------------------------ 2. wallet + preflight */}
      <Step n={2} title="Connect a wallet" done={owner?.kind === "eoa" && !!account}>
        {!eoa && (
          <div className="flex flex-wrap gap-2">
            {wallets.map((w) => (
              <button key={w.info.uuid} className={secondary} disabled={!!busy} onClick={() => connect(w)}>
                {w.info.icon && <img src={w.info.icon} alt="" className="mr-2 inline size-4 align-[-3px]" />}{w.info.name}
              </button>
            ))}
            <button className={secondary} disabled={!!busy} onClick={useBaseAccount}>Base Account</button>
            {wallets.length === 0 && <p className="w-full text-xs text-neutral-500 dark:text-neutral-400">No browser wallet detected. Install MetaMask or another wallet extension, or use a Base Account.</p>}
          </div>
        )}
        {eoa && (
          <ul className="space-y-1.5">
            <Check ok>Connected {walletName}: <span className="font-mono">{eoa}</span></Check>
            <Check ok={chainOk === true} pending={chainOk === null}>Network is Base Sepolia{switchBtn}</Check>
            <Check ok={owner?.kind === "eoa"} pending={!owner}>Standard account — read from the chain, not from the wallet</Check>
          </ul>
        )}
        {owner?.kind === "eip7702" && (
          <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
            <b>This account has been upgraded to a smart account (EIP-7702)</b>, delegating to <span className="font-mono">{short(owner.delegate)}</span>.
            Its signatures are checked by that contract, and we have not verified it accepts this permission — so we are not asking you to sign
            something that may fail. Use a different, standard account, or the Base Account option.
          </div>
        )}
        {owner?.kind === "contract" && (
          <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
            <b>This address is a contract, not a standard account.</b> A smart contract wallet cannot own the account this flow creates.
            A Safe or other multisig can pay by plain transfer instead — Retainer matches incoming transfers too.
          </div>
        )}
        {eoa && <button className="mt-3 text-xs text-neutral-500 underline" onClick={reset}>Use a different wallet</button>}
      </Step>

      {account && owner?.kind === "eoa" && (
        <>
          {/* ------------------------------------------ 3. funding, explicit */}
          <Step n={3} title="Put USDC in your smart account" done={funded}>
            <p className="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
              Charges are taken from a <b>smart account</b> that belongs to you, not from your {walletName} address directly. It is a
              separate address, it {deployed ? "already exists" : "is created when you sign — at no cost to you"}, and it{" "}
              {balance && balance > 0n ? "holds" : "starts with"} the balance below. Only you can move money out of it, except
              through the permission above.
            </p>
            <div className="mt-3 rounded-xl bg-neutral-50 p-4 dark:bg-neutral-800/60">
              <div className="text-xs text-neutral-500 dark:text-neutral-400">Your smart account</div>
              <div className="mt-0.5 break-all font-mono text-sm text-neutral-900 dark:text-white">{account}</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="font-mono text-2xl font-semibold text-neutral-900 dark:text-white">{balance === null ? "…" : usdc(balance)}</span>
                <span className="text-sm text-neutral-500">USDC</span>
                <span className={`ml-2 text-xs ${funded ? "text-emerald-600 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}`}>
                  {funded ? `enough for a full ${periodW}` : `needs at least ${usdc(allowance)} USDC to cover one ${periodW}`}
                </span>
              </div>
            </div>
            {!funded && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button className={secondary} disabled={!!busy || chainOk !== true} onClick={fundFromWallet}>Send {usdc(allowance)} USDC from {short(eoa)}</button>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  needs a little testnet ETH for gas · or get test USDC from <Link2 href="https://faucet.circle.com">Circle&apos;s faucet</Link2> sent straight to the address above
                </span>
              </div>
            )}
            {fundTx && <p className="mt-2 text-xs">Transfer: <Link2 href={scan("tx", fundTx)}>{short(fundTx)}</Link2></p>}
            {!funded && (
              <label className="mt-3 flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                <input type="checkbox" checked={ackUnfunded} onChange={(e) => setAckUnfunded(e.target.checked)} className="mt-0.5" />
                I&apos;ll fund it after signing. Until I do, charges will fail and be retried automatically.
              </label>
            )}
          </Step>

          {/* ------------------------------------------ 4. fingerprint + sign */}
          <Step n={4} title="Check the fingerprint, then sign" done={!!result}>
            <p className="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
              {walletName} cannot display these terms. It will show a request from <b>&ldquo;Coinbase Smart Wallet&rdquo;</b>, for the account{" "}
              <span className="font-mono">{short(account)}</span>, containing this fingerprint. <b>It must match exactly. If it does not, do not sign.</b>
            </p>
            <div className="mt-3 break-all rounded-xl bg-neutral-900 p-4 font-mono text-sm text-white dark:bg-black">{hash?.onchain ?? "computing…"}</div>
            <ul className="mt-3 space-y-1.5">
              <Check ok={hashOk} pending={!hash}>The fingerprint computed on this page equals the permission manager&apos;s own hash, read from the chain</Check>
              <Check ok={funded || ackUnfunded}>{funded ? "Your smart account is funded" : "You have acknowledged the account is not funded yet"}</Check>
              <Check ok={chainOk === true}>Your wallet is on Base Sepolia{switchBtn}</Check>
            </ul>
            {result ? (
              <p className="mt-4 text-sm font-medium text-emerald-700 dark:text-emerald-400">Signed and registered — details below.</p>
            ) : (
              <>
                <button className={`${primary} mt-4`} disabled={!canSign} onClick={sign}>Sign with {walletName}</button>
                <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">Signing costs you nothing. Retainer submits the registration and pays its gas.</p>
              </>
            )}
          </Step>
        </>
      )}

      {busy && <p className="text-sm text-neutral-600 dark:text-neutral-400">{busy}</p>}
      {err && <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700 ring-1 ring-red-500/30 dark:text-red-300">{err}</p>}

      {result && (
        <Step n={5} title="Registered" done>
          <ul className="space-y-1.5 text-sm">
            <Check ok>Permission #{result.permissionId} is live on Base Sepolia</Check>
            {result.approveTx && <Check ok>Registration: <Link2 href={scan("tx", result.approveTx)}>{short(result.approveTx)}</Link2>{result.accountCreatedByThisTx ? " — this also created your smart account" : ""}</Check>}
            <Check ok>Fingerprint <span className="font-mono">{short(result.permissionHash)}</span></Check>
          </ul>
        </Step>
      )}

      {existing.length > 0 && (
        <Step n={6} title="Your permissions">
          <ul className="divide-y divide-neutral-100 dark:divide-white/5">
            {existing.map((p) => {
              const r = revoked[p.permissionHash] ?? p.revokeTx;
              return (
                <li key={p.permissionHash} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <div className="font-mono">#{p.id} · {short(p.permissionHash)}</div>
                    <div className="text-xs text-neutral-500 dark:text-neutral-400">
                      {usdc(p.permission.allowance)} USDC per {periodWords(p.permission.period)} · expires {when(p.permission.end)}
                    </div>
                  </div>
                  {r
                    ? <span className="text-xs text-neutral-500">revoked · <Link2 href={scan("tx", r)}>{short(r)}</Link2></span>
                    : <button className={secondary} disabled={!!busy || chainOk !== true} title={chainOk !== true ? "Switch your wallet to Base Sepolia first" : undefined} onClick={() => revoke(p)}>Revoke</button>}
                </li>
              );
            })}
          </ul>
        </Step>
      )}
    </div>
  );
}
