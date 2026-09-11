import Link from 'next/link';
import { SignFlow } from '@/components/sign/sign-flow';
import { loadLink, linkState, linkView } from '../../../../lib/links.js';

export const dynamic = 'force-dynamic';

// The token is the link's only protection; it must never end up in a search index.
export async function generateMetadata({ params }) {
  const { token } = await params;
  const row = await loadLink(token);
  return {
    title: row && linkState(row) === 'valid' ? `${row.merchant_name} — authorise payments` : 'Payment link — Retainer',
    robots: { index: false, follow: false },
  };
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const day = (d) => new Date(d).toISOString().slice(0, 10);
const cta = 'text-brand-primary hover:underline';

/** A link that cannot be used: what happened, in plain words, and where to go instead. */
function Closed({ state, title, children }) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 md:px-8 md:py-24" data-link-state={state}>
      <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Payment link</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">{title}</h1>
      <div className="mt-4 space-y-3 text-sm leading-6 text-neutral-700 dark:text-neutral-300">{children}</div>
      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        Already set up a payment? Your permissions, charges and the option to cancel are on <Link href="/account" className={cta}>your permissions page</Link>.
      </p>
    </div>
  );
}

export default async function Page({ params }) {
  const { token } = await params;
  const row = await loadLink(token);
  const state = linkState(row);

  if (state === 'not_found') return (
    <Closed state={state} title="This payment link doesn't exist">
      <p>Nothing has been set up from it, and nothing can be charged. It may have been copied incompletely — links are long.</p>
      <p>Ask the merchant who sent it to send it again.</p>
    </Closed>
  );
  const m = row.merchant_name;
  if (state === 'revoked') return (
    <Closed state={state} title={`${m} has withdrawn this link`}>
      <p>No new payment can be set up from it. If you already authorised payments through it, that permission is not affected by this — only you or the merchant can revoke it.</p>
      <p>If you still mean to pay {m}, ask them for a new link.</p>
    </Closed>
  );
  if (state === 'used') return (
    <Closed state={state} title="This link has already been used">
      <p>It was made for one sign-up, and that has happened. If it was you, your payment is set up — see it on your permissions page below.</p>
      <p>If it wasn&apos;t you, ask {m} for a new link.</p>
    </Closed>
  );
  if (state === 'expired') return (
    <Closed state={state} title="This link has expired">
      <p>It stopped accepting new sign-ups on {day(row.expires_at)}. Nothing has been set up from it since.</p>
      <p>Ask {m} for a new link.</p>
    </Closed>
  );

  const view = linkView(row);
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-8 md:py-16" data-link-state="valid">
      <p className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Payment authorisation · Base Sepolia test deployment</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">{m} is asking you to authorise payments</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        Paid to <span className="font-mono">{short(view.treasury)}</span> · billing by Retainer. Read the terms below before connecting anything —
        your wallet will not be able to show them to you. You sign once; Retainer registers it on-chain and pays the gas.
      </p>
      <div className="mt-8"><SignFlow link={view} /></div>
    </div>
  );
}
