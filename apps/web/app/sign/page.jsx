'use client';

import { useState } from 'react';

/**
 * Test harness, not a product surface.
 *
 * One button: connect a real Base Account and sign a spend permission naming
 * Retainer's deployed SpendRouter as spender, with extraData encoding
 * (executor, recipient). The signature goes to our backend, which submits
 * approveWithSignature -- so the signer pays no gas at any point.
 *
 * Layout: the shared layout already offsets the fixed nav and fills the
 * viewport, so this page only needs its own container padding.
 */
export default function Page() {
  const [state, setState] = useState('idle');
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);

  async function run() {
    setErr(null); setOut(null); setState('connecting');
    try {
      const [{ createBaseAccountSDK }, { requestSpendPermission }, cfgRes] = await Promise.all([
        import('@base-org/account/browser'),
        import('@base-org/account/spend-permission/browser'),
        fetch('/api/permissions'),
      ]);
      const cfg = await cfgRes.json();

      const sdk = createBaseAccountSDK({ appName: 'Retainer (test harness)', appChainIds: [cfg.chainId] });
      const provider = sdk.getProvider();

      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      const account = accounts[0];
      setState('signing');

      const permission = await requestSpendPermission({
        account,
        spender: cfg.router,          // the deployed SpendRouter IS the spender
        token: cfg.usdc,
        chainId: cfg.chainId,
        allowance: BigInt(cfg.allowance),
        periodInDays: cfg.periodInDays,
        extraData: cfg.extraData,     // abi.encode(executor, recipient)
        provider,
      });

      setState('registering');
      const res = await fetch('/api/permissions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(permission, (k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'registration failed');
      setOut(body);
      setState('done');
    } catch (e) {
      setErr(String(e?.message ?? e));
      setState('error');
    }
  }

  const busy = state === 'connecting' || state === 'signing' || state === 'registering';

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 font-mono text-sm md:px-8 md:py-16">
      <h1 className="text-lg font-bold text-neutral-900 dark:text-white">Retainer — sign a spend permission</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
        Base Sepolia test harness. You sign; Retainer submits the on-chain registration and pays the gas.
      </p>

      {/* Stated limitation, so a visitor is not sent into an unexplained dead end. */}
      <div className="mt-6 rounded-lg border border-neutral-300 bg-neutral-50 p-4 text-[13px] leading-6 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        <p className="font-semibold text-neutral-900 dark:text-white">Known limitation — this may not complete for you.</p>
        <p className="mt-1">
          Coinbase&apos;s hosted consent screen currently refuses Base Sepolia for <em>newly created</em> Base Accounts, showing
          &ldquo;This chain is not supported.&rdquo; It is an open upstream issue:{' '}
          <a href="https://github.com/base/account-sdk/issues/363" target="_blank" rel="noopener noreferrer" className="text-brand-primary underline">base/account-sdk#363</a>.
          It is not a chain-support decision — the refusal is testnet delegation provisioning for EIP-7702 accounts.
        </p>
        <p className="mt-1">
          The ERC-4337 path signs and charges normally against the same manager on the same chain; the six confirmed charges on the
          landing page were made that way. Accounts created before the 7702 provisioning change reportedly still work here.
        </p>
      </div>

      <button
        onClick={run}
        disabled={busy}
        className="mt-6 rounded-md border border-neutral-400 px-3 py-2 text-neutral-900 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:text-white dark:hover:bg-neutral-800"
      >
        {busy ? state : 'Connect Base Account and sign'}
      </button>

      <div className="mt-4 text-neutral-600 dark:text-neutral-400">state: {state}</div>
      {err && <pre className="mt-2 whitespace-pre-wrap text-red-700 dark:text-red-400">error: {err}</pre>}
      {out && <pre className="mt-2 whitespace-pre-wrap rounded-md border border-neutral-300 p-3 dark:border-neutral-700">{JSON.stringify(out, null, 2)}</pre>}
    </div>
  );
}
