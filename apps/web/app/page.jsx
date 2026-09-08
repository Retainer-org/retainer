'use client';

import { useState } from 'react';

/**
 * Test harness, not a product surface.
 *
 * One button: connect a real Base Account and sign a spend permission naming
 * Retainer's deployed SpendRouter as spender, with extraData encoding
 * (executor, recipient). The signature goes to our backend, which submits
 * approveWithSignature -- so the signer pays no gas at any point.
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

      const sdk = createBaseAccountSDK({
        appName: 'Retainer (test harness)',
        appChainIds: [cfg.chainId],
      });
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

  return (
    <main className="max-w-3xl space-y-4">
      <h1 className="font-bold">Retainer — sign a spend permission</h1>
      <p className="text-gray-600">
        Base Sepolia test harness. You sign; Retainer submits the on-chain
        registration and pays the gas.
      </p>

      <button
        onClick={run}
        disabled={state === 'connecting' || state === 'signing' || state === 'registering'}
        className="border px-3 py-2 disabled:opacity-50"
      >
        {state === 'idle' || state === 'error' || state === 'done'
          ? 'Connect Base Account and sign'
          : state}
      </button>

      <div>state: {state}</div>
      {err && <pre className="whitespace-pre-wrap text-red-700">error: {err}</pre>}
      {out && <pre className="whitespace-pre-wrap border p-3">{JSON.stringify(out, null, 2)}</pre>}
    </main>
  );
}
