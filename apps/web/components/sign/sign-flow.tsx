"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWalletClient, custom, encodeFunctionData, getAddress, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  checkOwner, deriveSmartAccount, erc20Abi, localPermissionHash, managerDomain,
  smartWalletAbi, smartWalletTypedData, spendPermissionManagerAbi, toStruct,
} from "@retainer/chain";
import {
  CHAIN_HEX, Check, FAUCETS, Link2, Row, Step, periodWords, primary, pub, scan, secondary, short, switchNetwork,
  useInjectedWallets, usdc, when, type Announced, type Eip1193,
} from "./ui";

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
type Policy = {
  chainId: number; manager: Hex; router: Hex; usdc: Hex; executor: Hex; treasury: Hex; factory: Hex; extraData: Hex;
  allowance: string; periodSeconds: number; periodInDays: number; durationSeconds: number;
  registrationEnabled?: boolean;
  registrationClosedReason?: "no_executor_key" | "gas_tank_low" | null;
  fixedStart?: number | null;
};
type Struct = ReturnType<typeof toStruct>;

/** A billing link, as /pay/<token> passes it in. Its terms are shown here; registration re-derives them from the row. */
export type LinkView = {
  token: string; merchantName: string; treasury: Hex; allowance: string; periodSeconds: number; durationSeconds: number;
  startAt: number | null; firstCharge: "at_signup" | "end_of_first_period" | "none"; firstChargeAmount: string | null;
  expiresAt: string; singleUse: boolean;
};

/** Accounts that registered in this browser session, so a different account can be called out. */
type SessionReg = { eoa: string; permissionId: string };
const SESSION_KEY = "retainer.sign.registered";
const readSession = (): SessionReg[] => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "[]"); } catch { return []; } };
const writeSession = (v: SessionReg[]) => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)); } catch { /* private mode */ } };

const randomSalt = () => {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
};

/* ======================================================================= */
export function SignFlow({ link }: { link?: LinkView } = {}) {
  const [pol, setPol] = useState<Policy | null>(null);
  const wallets = useInjectedWallets();
  const [provider, setProvider] = useState<Eip1193 | null>(null);
  const [walletName, setWalletName] = useState("");
  const [eoa, setEoa] = useState<Hex | null>(null);
  const [chainOk, setChainOk] = useState<boolean | null>(null);
  const [owner, setOwner] = useState<Awaited<ReturnType<typeof checkOwner>> | null>(null);
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
  const [needEth, setNeedEth] = useState(false);
  const [sessionRegs, setSessionRegs] = useState<SessionReg[]>([]);
  useEffect(() => { setSessionRegs(readSession()); }, []);
  const baseSdk = useRef<any>(null);

  // A link's terms come from the link; the operator page's from configuration. Either way registration pins them server-side.
  useEffect(() => {
    fetch(link ? `/api/links/${link.token}` : "/api/permissions").then((r) => r.json())
      .then((j) => { const p = link ? j.policy : j; if (p) setPol(p); else setErr("This link can no longer be used. Reload the page to see why."); })
      .catch(() => setErr("Could not load the terms."));
  }, [link]);

  const allowance = pol ? BigInt(pol.allowance) : 0n;
  const wc = useMemo(() => (provider && eoa ? createWalletClient({ account: eoa, chain: baseSepolia, transport: custom(provider) }) : null), [provider, eoa]);

  const reset = () => {
    setEoa(null); setOwner(null); setAccount(null); setDeployed(null); setBalance(null); setStruct(null);
    setHash(null); setResult(null); setErr(null); setAckUnfunded(false); setFundTx(null); setChainOk(null);
  };

  /* ---------------------------------------------------------- connect + preflight */
  /**
   * Every check, for one account. Runs on connect and again whenever the wallet reports a different
   * account, so the page always describes the account actually connected -- never a previous one.
   */
  const checkAccount = useCallback(async (p: Eip1193, addr: string, { askToSwitch = false } = {}) => {
    if (!pol) return;
    const me = getAddress(addr);
    setEoa(me); setOwner(null); setAccount(null); setDeployed(null); setBalance(null); setStruct(null);
    setHash(null); setResult(null); setErr(null); setNeedEth(false); setAckUnfunded(false); setFundTx(null);
    setBusy("Checking your account…");
    try {
      // Ask the wallet to switch only on first connect; after that, the network check and its button say what to do.
      const cid = await p.request({ method: "eth_chainId" });
      setChainOk(cid === CHAIN_HEX ? true : askToSwitch ? await switchNetwork(p).catch(() => false) : false);

      // Owner code from the chain -- not from anything the wallet says about itself. A customer's existing
      // permissions are not listed here: they are served only after sign-in, at /account.
      const kind = await checkOwner(pub, me);
      setOwner(kind);
      if (!kind.accepted) return;

      const acct = await deriveSmartAccount(pub, me, pol.manager);
      setAccount(acct);
      const code = await pub.getCode({ address: acct });
      setDeployed(!!code && code !== "0x");

      // The exact struct that will be hashed, signed and submitted. Everything on screen reads from it.
      const start = pol.fixedStart ?? Math.floor(Date.now() / 1000);
      const s = toStruct({ account: acct, spender: pol.router, token: pol.usdc, allowance: pol.allowance,
        period: pol.periodSeconds, start, end: start + pol.durationSeconds, salt: randomSalt(), extraData: pol.extraData });
      setStruct(s);
      const [dom, onchain] = await Promise.all([
        managerDomain(pub, pol.manager),
        pub.readContract({ address: pol.manager, abi: spendPermissionManagerAbi, functionName: "getHash", args: [s] }) as Promise<Hex>,
      ]);
      setHash({ local: localPermissionHash(dom, s), onchain });

    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? String(e));
    } finally { setBusy(null); }
  }, [pol]);

  const connect = useCallback(async (w: Announced) => {
    reset(); setErr(null); setBusy("Connecting…");
    try {
      setProvider(w.provider); setWalletName(w.info.name);
      const [addr] = await w.provider.request({ method: "eth_requestAccounts" });
      await checkAccount(w.provider, addr, { askToSwitch: true });
    } catch (e: any) { setErr(e?.shortMessage ?? e?.message ?? String(e)); setBusy(null); }
  }, [checkAccount]);

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
    // A different account gets every check re-run for it, so a refusal for the previous account can never
    // linger on screen. A different network changes nothing already shown, so only that check is re-evaluated.
    const onAccounts = (accts: string[]) => { if (accts?.[0]) checkAccount(provider, accts[0]); else reset(); };
    const onChain = (id: string) => setChainOk(id === CHAIN_HEX);
    provider.on("accountsChanged", onAccounts); provider.on("chainChanged", onChain);
    return () => { provider.removeListener?.("accountsChanged", onAccounts); provider.removeListener?.("chainChanged", onChain); };
  }, [provider, checkAccount]);

  /* ---------------------------------------------------------------- actions */
  async function switchAccount() {
    if (!provider) return;
    setErr(null); setBusy(`Choose an account in ${walletName}…`);
    try {
      // Opens the wallet's own account picker. The chosen account arrives through accountsChanged; it is
      // also read back here, for wallets that do not emit the event.
      await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      const [addr] = await provider.request({ method: "eth_accounts" });
      if (addr) await checkAccount(provider, addr);
    } catch (e: any) {
      setErr(`${walletName} did not open its account picker (${e?.shortMessage ?? e?.message ?? e}). Switch the account inside ${walletName} — this page follows the change.`);
    } finally { setBusy(null); }
  }

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
    } catch (e: any) { const m = e?.shortMessage ?? e?.message ?? String(e); setErr(m); setNeedEth(/insufficient funds|gas/i.test(m)); }
    finally { setBusy(null); }
  }

  async function withdraw() {
    if (!wc || !account || !pol || !eoa || balance === null || balance <= 0n) return;
    setErr(null); setNeedEth(false); setBusy("Waiting for your wallet…");
    try {
      // Only an owner can move money out of the smart account, and the customer's wallet is one.
      const tx = await wc.writeContract({ address: account, abi: smartWalletAbi, functionName: "execute", account: eoa, chain: baseSepolia,
        args: [pol.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [eoa, balance] })] });
      setFundTx(tx); setBusy("Waiting for the withdrawal to confirm…");
      await pub.waitForTransactionReceipt({ hash: tx });
      setBalance(await pub.readContract({ address: pol.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account] }) as bigint);
    } catch (e: any) { const m = e?.shortMessage ?? e?.message ?? String(e); setErr(m); setNeedEth(/insufficient funds|gas/i.test(m)); }
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
        body: JSON.stringify({ path: "eoa_owned", signerEoa: eoa, signature, permissionHash: hash.onchain, ...(link ? { link: link.token } : {}),
          permission: { ...struct, allowance: struct.allowance.toString(), salt: struct.salt.toString() } }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "registration failed");
      setResult(body); setDeployed(true);
      const regs = [...readSession(), { eoa, permissionId: String(body.permissionId) }];
      writeSession(regs); setSessionRegs(regs);
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
        body: JSON.stringify({ path: "base_account", permission: sp.permission, signature: sp.signature, permissionHash: sp.permissionHash, ...(link ? { link: link.token } : {}) },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v)) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "registration failed");
      setResult(body);
    } catch (e: any) {
      const m = e?.shortMessage ?? e?.message ?? String(e);
      setErr(/not supported/i.test(m)
        ? `${m} — Coinbase's consent screen is refusing Base Sepolia for this account (base/account-sdk#363). Connect a browser wallet instead: it does not use that screen.`
        : m);
    }
    finally { setBusy(null); }
  }

  /* ---------------------------------------------------------------- gating */
  const hashOk = !!hash && hash.local.toLowerCase() === hash.onchain.toLowerCase();
  const funded = balance !== null && balance >= allowance;
  // A first charge taken at signup needs the money there first -- no "I'll fund it later" (the server enforces this too).
  const firstAtSignup = link?.firstCharge === "at_signup";
  const firstAmt = link?.firstChargeAmount ? BigInt(link.firstChargeAmount) : 0n;
  const fundedForFirst = balance !== null && balance >= firstAmt;
  const fundingOk = firstAtSignup ? fundedForFirst : funded || ackUnfunded;
  const canSign = pol?.registrationEnabled !== false && !!struct && hashOk && owner?.accepted === true && chainOk === true && fundingOk && !busy && !result;

  if (!pol) return <p className="text-sm text-neutral-500">{err ?? "Loading the terms…"}</p>;
  const otherSessionSigners = eoa ? sessionRegs.filter((r) => r.eoa.toLowerCase() !== eoa.toLowerCase()) : [];
  const switchAcctBtn = (
    <button className={`${secondary} !px-2.5 !py-1 text-xs`} disabled={!!busy} onClick={switchAccount}>Switch account in {walletName}</button>
  );
  const switchBtn = chainOk === false && (
    <button className={`${secondary} ml-3 !px-2.5 !py-1 text-xs`} disabled={!!busy} onClick={doSwitch}>Switch to Base Sepolia</button>
  );
  const periodW = periodWords(pol.periodSeconds);
  const days = pol.durationSeconds / 86400;
  const who = link?.merchantName;
  const whenCharged = !link ? null
    : link.firstCharge === "at_signup" ? <>The first <b>{usdc(firstAmt)} USDC</b> is taken as soon as you sign. After that, {who} decides when to bill — never more than {usdc(allowance)} USDC in any {periodW}.</>
    : link.firstCharge === "end_of_first_period" ? <>The first <b>{usdc(firstAmt)} USDC</b> is taken at the end of your first {periodW}. After that, {who} decides when to bill — never more than {usdc(allowance)} USDC in any {periodW}.</>
    : <>Nothing is taken when you sign. {who} decides when to bill — never more than {usdc(allowance)} USDC in any {periodW}.</>;

  return (
    <div className="space-y-5">
      {pol.registrationEnabled === false && pol.registrationClosedReason === "gas_tank_low" && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
          <b>Registration is paused.</b> The executor that pays the gas for registering is running low, so the sign button stays off
          until it is refilled. You can still read the terms, check your account, and revoke a permission you already have.
        </p>
      )}
      {pol.registrationEnabled === false && pol.registrationClosedReason !== "gas_tank_low" && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
          <b>Signing is not switched on for this deployment yet.</b> You can read the terms and check your account, but registering a
          permission needs Retainer&apos;s executor, which this deployment does not run — so the sign button stays off and nothing is submitted.
        </p>
      )}
      {/* ------------------------------------------------ 1. the terms, first */}
      <Step n={1} title="What you are agreeing to">
        <p className="text-base leading-7 text-neutral-900 dark:text-white">
          {who ? <b>{who}</b> : "Retainer"} can collect <b>at most {usdc(allowance)} USDC in any {periodW}</b> from your account, for {days} days.
          It cannot take more, and unused allowance does not carry over to the next {periodW}.
        </p>
        {whenCharged && (
          <div className="mt-3 rounded-xl bg-neutral-50 p-3 text-sm leading-6 text-neutral-800 dark:bg-neutral-800/60 dark:text-neutral-200" data-when-charged>
            <div className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">When you are charged</div>
            <p className="mt-1">{whenCharged}</p>
          </div>
        )}
        <div className="mt-4">
          <Row k="Token">USDC · <Link2 href={scan("address", pol.usdc)}>{short(pol.usdc)}</Link2> on Base Sepolia</Row>
          <Row k="Exact cap">{usdc(allowance, 6)} USDC ({allowance.toString()} base units) per {periodW}</Row>
          <Row k="Starts">{struct ? when(struct.start) : "when you sign"}</Row>
          <Row k="Expires">{struct ? when(struct.end) : `${days} days after you sign`} — after that it can never be used again</Row>
          <Row k="Collected by">Retainer&apos;s SpendRouter <Link2 href={`${scan("address", pol.router)}#code`}>{short(pol.router)}</Link2> (verified source), which forwards the full amount in the same transaction and keeps none of it</Row>
          <Row k="Paid to">
            {link
              ? <><Link2 href={scan("address", pol.treasury)}>{short(pol.treasury)}</Link2> — &ldquo;{who}&rdquo; is the name on this link, not a verified identity. This address is where the money goes.</>
              : <>Merchant treasury <Link2 href={scan("address", pol.treasury)}>{short(pol.treasury)}</Link2></>}
          </Row>
          {link && <Row k="This link">Valid until {link.expiresAt.replace("T", " ").slice(0, 16)} UTC · {link.singleUse ? "can be used once" : "can be used by anyone who has it"}</Row>}
          <Row k="To stop it">Revoke at any time from <Link href="/account" className="text-brand-primary hover:underline">your permissions page</Link> by connecting the same wallet: one transaction from your wallet, which may ask for a small network fee. The merchant can also revoke it. Either way it is enforced by the contract, not by us.</Row>
        </div>
      </Step>

      {/* ------------------------------------------------ 2. wallet + preflight */}
      <Step n={2} title="Connect a wallet" done={owner?.accepted === true && !!account}>
        {!eoa && (
          <div className="flex flex-wrap gap-2">
            {wallets.map((w) => (
              <button key={w.info.uuid} className={secondary} disabled={!!busy} onClick={() => connect(w)}>
                {w.info.icon && <img src={w.info.icon} alt="" className="mr-2 inline size-4 align-[-3px]" />}{w.info.name}
              </button>
            ))}
            <button className={secondary} disabled={!!busy} onClick={useBaseAccount}>Base Account</button>
            {wallets.length === 0 && <p className="w-full text-xs text-neutral-500 dark:text-neutral-400">No browser wallet detected. <Link2 href="https://metamask.io/download/">Install MetaMask</Link2> or another wallet extension and reload this page, or use a Base Account.</p>}
          </div>
        )}
        {eoa && (
          <div className="mb-3 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800/60">
            <div className="text-xs text-neutral-500 dark:text-neutral-400">Connected account in {walletName}</div>
            <div className="mt-0.5 break-all font-mono text-sm font-semibold text-neutral-900 dark:text-white">{eoa}</div>
            {otherSessionSigners.length > 0 && (
              <div className="mt-2 rounded-lg bg-amber-500/10 p-2.5 text-xs leading-5 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
                <b>This is a different account</b> from the one that registered earlier in this browser session
                {" "}({otherSessionSigners.map((r) => `${short(r.eoa)}, permission #${r.permissionId}`).join("; ")}). {walletName} connects
                whichever account is selected in it. If you meant that account, switch to it: <span className="ml-1 inline-block">{switchAcctBtn}</span>
              </div>
            )}
          </div>
        )}
        {eoa && (
          <ul className="space-y-1.5">
            <Check ok={chainOk === true} pending={chainOk === null}>Network is Base Sepolia{switchBtn}</Check>
            <Check ok={owner?.accepted === true} pending={!owner}>
              {owner?.kind === "eip7702" && owner.accepted
                ? <>Upgraded by {walletName} to its verified delegator — accepted: it checks signatures exactly as a standard account does, and its code is checked against the reviewed version</>
                : "Standard account — read from the chain, not from the wallet"}
            </Check>
          </ul>
        )}
        {owner?.kind === "eip7702" && !owner.accepted && (
          <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
            <b>{short(eoa)} has been upgraded to a smart account (EIP-7702)</b>, delegating to <span className="font-mono">{short(owner.delegate)}</span>.
            {" "}{walletName} can do this by itself when an account sends a transaction through it.
            {"reason" in owner && owner.reason === "delegate_code_changed"
              ? " That delegator is one this deployment trusts, but the code at its address no longer matches the version that was verified — so it is refused until it has been reviewed again."
              : " Signatures from an upgraded account are checked by that contract, and it is not one this deployment has verified — so we are not asking you to sign something that would be refused."}
            {" "}Permissions you already signed keep working, and you can revoke them from <Link href="/account" className="text-brand-primary hover:underline">your permissions page</Link>.
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>To continue:</span>{switchAcctBtn}
              <button className={`${secondary} !px-2.5 !py-1 text-xs`} disabled={!!busy} onClick={useBaseAccount}>Use a Base Account instead</button>
            </div>
          </div>
        )}
        {owner?.kind === "contract" && (
          <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm leading-6 text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
            <b>This address is a contract, not a standard account.</b> A smart contract wallet cannot own the account this flow creates.
            A Safe or other multisig can pay by plain transfer instead — Retainer matches incoming transfers too.
            <div className="mt-2 flex flex-wrap items-center gap-2"><span>Or choose a standard account:</span>{switchAcctBtn}</div>
          </div>
        )}
        {eoa && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            {owner?.accepted === true && switchAcctBtn}
            <button className="text-neutral-500 underline" onClick={reset}>Use a different wallet app</button>
          </div>
        )}
      </Step>

      {account && owner?.accepted === true && (
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
            {deployed && balance !== null && balance > 0n && (
              <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-neutral-600 dark:text-neutral-400">
                <button className={secondary} disabled={!!busy || chainOk !== true} onClick={withdraw}>Withdraw {usdc(balance)} USDC to {short(eoa)}</button>
                <span>It is yours: this moves it back to your wallet. Charges then fail until the account is funded again.</span>
              </div>
            )}
            {!funded && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button className={secondary} disabled={!!busy || chainOk !== true} onClick={fundFromWallet}>Send {usdc(allowance)} USDC from {short(eoa)}</button>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  needs a little <Link2 href={FAUCETS}>Base Sepolia ETH</Link2> for gas · or get test USDC from <Link2 href="https://faucet.circle.com">Circle&apos;s faucet</Link2> sent straight to the address above
                </span>
              </div>
            )}
            {fundTx && <p className="mt-2 text-xs">Transfer: <Link2 href={scan("tx", fundTx)}>{short(fundTx)}</Link2></p>}
            {firstAtSignup && (
              <p className={`mt-3 text-sm ${fundedForFirst ? "text-emerald-700 dark:text-emerald-400" : "text-amber-800 dark:text-amber-300"}`}>
                Your first charge of {usdc(firstAmt)} USDC is taken as soon as you sign, so this account must hold it first{fundedForFirst ? " — it does." : "."}
              </p>
            )}
            {!funded && !firstAtSignup && (
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
              <Check ok={hashOk} pending={!hash}>
                The fingerprint computed on this page equals the permission manager&apos;s own hash, read from the chain
                {hash && !hashOk && <span className="block text-xs text-red-600 dark:text-red-400">They differ, so signing is blocked. Reload the page; if it persists, do not sign.</span>}
              </Check>
              <Check ok={fundingOk}>{firstAtSignup ? (fundedForFirst ? `Your smart account holds the first charge (${usdc(firstAmt)} USDC)` : `Your smart account must hold the first charge (${usdc(firstAmt)} USDC) before you sign`)
                : funded ? "Your smart account is funded" : "You have acknowledged the account is not funded yet"}</Check>
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
      {err && (
        <p className="rounded-lg bg-red-500/10 p-3 text-sm text-red-700 ring-1 ring-red-500/30 dark:text-red-300">
          {err}
          {needEth && <> Your wallet needs a little Base Sepolia ETH for this transaction — <Link2 href={FAUCETS}>faucets</Link2>.</>}
        </p>
      )}

      {result && link && <FirstCharge result={result} merchant={who!} />}
      {result && !link && (
        <Step n={5} title="Registered" done>
          <ul className="space-y-1.5 text-sm">
            <Check ok>Permission #{result.permissionId} is live on Base Sepolia</Check>
            {result.approveTx && <Check ok>Registration: <Link2 href={scan("tx", result.approveTx)}>{short(result.approveTx)}</Link2>{result.accountCreatedByThisTx ? " — this also created your smart account" : ""}</Check>}
            <Check ok>Fingerprint <span className="font-mono">{short(result.permissionHash)}</span></Check>
          </ul>
          <p className="mt-4 text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            Come back to <Link href="/account" className="font-medium text-brand-primary hover:underline">your permissions page</Link> any time to see what has been
            taken under it and to cancel it. Connect this same wallet there.
          </p>
        </Step>
      )}

    </div>
  );
}

/* ---------------------------------------------------------------- after signing, on a link */
const FAILURE: Record<string, string> = {
  INSUFFICIENT_BALANCE: "your smart account did not hold enough USDC", ALLOWANCE_EXHAUSTED: "this period's cap was already used",
  REVOKED: "the permission was revoked", EXPIRED: "the permission had expired", NOT_STARTED: "the permission had not started yet",
  NOT_APPROVED: "the permission was not registered on-chain", UNKNOWN: "an unexpected error",
};

/**
 * The first charge of the permission just created, watched right here -- no sign-in, no trip to
 * another page. It reads only through the receipt registration returned to this page, which names
 * this one permission and nothing else; there is no way to ask it about any other.
 */
function FirstCharge({ result, merchant }: { result: any; merchant: string }) {
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const rule = result.firstCharge?.rule;
  useEffect(() => {
    if (!result.receipt || rule === "none") return;
    let stop = false, t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch(`/api/pay/progress?receipt=${encodeURIComponent(result.receipt)}`);
        const j = await r.json();
        if (!r.ok) { setErr(j.error ?? "Could not read the charge."); return; }
        if (stop) return;
        setP(j);
        if (["confirmed", "failed_terminal"].includes(j.charge?.state) || rule === "end_of_first_period") return;
      } catch { /* try again */ }
      if (!stop) t = setTimeout(tick, 3000);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
  }, [result.receipt, rule]);

  const ch = p?.charge;
  const amount = result.firstCharge?.amount ? usdc(result.firstCharge.amount) : "";
  const done = ch?.state === "confirmed";
  return (
    <Step n={5} title="Authorised" done>
      <ul className="space-y-1.5 text-sm" data-first-charge={ch?.state ?? (rule === "none" ? "none" : "waiting")}>
        <Check ok>Permission #{result.permissionId} is live{result.approveTx && <> — <Link2 href={scan("tx", result.approveTx)}>registration</Link2>{result.accountCreatedByThisTx ? ", which also created your smart account" : ""}</>}</Check>
        {rule === "at_signup" && (<>
          <Check ok={!!ch} pending={!ch}>First charge of {amount} USDC scheduled</Check>
          <Check ok={!!ch?.sentTx} pending={!!ch && !ch.sentTx && !ch.failure}>Sent to Base Sepolia{ch?.sentTx && <> — <Link2 href={scan("tx", ch.sentTx)}>{short(ch.sentTx)}</Link2></>}</Check>
          <Check ok={done} pending={!done && ch?.state !== "failed_terminal"}>
            {done ? <>Confirmed — <b>{usdc(ch.settledAmount ?? ch.amount)} USDC</b> settled to {merchant} · <Link2 href={scan("tx", ch.confirmedTx)}>Basescan</Link2></> : "Confirmed on-chain"}
          </Check>
        </>)}
        {rule === "end_of_first_period" && <Check ok pending={!ch}>First charge of {amount} USDC scheduled for {ch ? ch.dueAt.replace("T", " ").slice(0, 16) + " UTC" : "the end of your first period"}</Check>}
        {rule === "none" && <Check ok>Nothing is taken now. {merchant} will bill you when a payment falls due, never more than your cap.</Check>}
      </ul>
      {ch?.failure && !done && (
        <p className="mt-3 rounded-lg bg-amber-500/10 p-3 text-sm text-neutral-800 ring-1 ring-amber-500/40 dark:text-neutral-200">
          Not taken yet: {FAILURE[ch.failure] ?? ch.failure.toLowerCase()}. {ch.state === "failed_terminal" ? "It will not be retried." : "It will be retried automatically."}
        </p>
      )}
      {err && <p className="mt-3 text-xs text-neutral-500">{err}</p>}
      <p className="mt-4 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        To see charges later or cancel, come back to <Link href="/account" className="text-brand-primary hover:underline">your permissions page</Link> with this same wallet.
      </p>
    </Step>
  );
}
