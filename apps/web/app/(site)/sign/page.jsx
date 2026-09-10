import { SignFlow } from '@/components/sign/sign-flow';

/**
 * Sign a spend permission. Two paths, both first-class:
 *   - any injected wallet (MetaMask, Rabby, ...): the customer's EOA owns a smart account
 *     created for it, and signs typed data the account validates;
 *   - a Base Account, through Coinbase's own consent screen.
 * Either way the customer pays no gas: Retainer submits the registration.
 */
export default function Page() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-8 md:py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">Authorise a recurring USDC payment</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        Base Sepolia test deployment. You sign once; Retainer registers it on-chain and pays the gas. Read the terms below before
        connecting anything — your wallet will not be able to show them to you.
      </p>
      <div className="mt-8"><SignFlow /></div>
      <p className="mt-8 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
        The Base Account option uses Coinbase&apos;s hosted consent screen, which currently refuses newly created Base Accounts on Base
        Sepolia (<a href="https://github.com/base/account-sdk/issues/363" target="_blank" rel="noopener noreferrer" className="text-brand-primary underline">base/account-sdk#363</a>).
        Browser wallets do not go through that screen.
      </p>
    </div>
  );
}
