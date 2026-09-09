"use client";

import { useActionState, useState } from "react";
import { Hash, Pill, fmt, usdc } from "./ui";
import { applyToPayment, markNotAPayment, linkSenderToCustomer } from "@/app/dashboard/review/actions";
import type { CustomerRow, ReviewRow } from "@/lib/dashboard-data";

/**
 * One item in the review queue: the transfer, why the matcher declined to
 * guess, the candidates it considered, and the five actions.
 *
 * The point of this card is that the product's judgement is legible. A merchant
 * should be able to see exactly what evidence existed and why it was not enough,
 * rather than being told "needs review" and left to work it out.
 */

const REASONS: Record<string, { title: string; why: string; tone: "warn" | "muted" | "bad" }> = {
  ambiguous_multiple_exact: {
    title: "More than one obligation matches exactly",
    why: "The sender is known and the amount is exact — but it fits more than one open payment. Picking one would be a guess, so nothing was applied.",
    tone: "warn",
  },
  amount_mismatch: {
    title: "Known sender, different amount",
    why: "This customer is recognised, but the amount does not equal what any of their open payments still owes. A short payment is either a partial or an agreed discount, and those mean opposite things about whether money is still owed. Nothing in the data distinguishes them.",
    tone: "warn",
  },
  unknown_sender: {
    title: "Amount matches, sender is not recognised",
    why: "An open payment expects exactly this amount, but this address has never been linked to a customer. Linking it below both resolves this and teaches the matcher for next time.",
    tone: "muted",
  },
  no_open_payment_for_sender: {
    title: "Known customer, nothing outstanding",
    why: "This address belongs to a customer, but that customer has no open expected payment. It may be an early payment, a duplicate, or something that is not a payment at all.",
    tone: "muted",
  },
  unattributed: {
    title: "Matches nothing",
    why: "Neither the sender nor the amount corresponds to anything open. It is surfaced rather than discarded so it can be attributed by hand.",
    tone: "muted",
  },
};

function Feedback({ state }: { state: { ok: boolean; detail?: string; error?: string } | null }) {
  if (!state) return null;
  return (
    <p className={`mt-2 text-xs ${state.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}>
      {state.ok ? state.detail : state.error}
    </p>
  );
}

export function ReviewCard({ row, customers }: { row: ReviewRow; customers: CustomerRow[] }) {
  const meta = REASONS[row.reason] ?? { title: row.reason, why: "", tone: "muted" as const };
  const [applyState, applyAction, applying] = useActionState(applyToPayment, null);
  const [ignoreState, ignoreAction, ignoring] = useActionState(markNotAPayment, null);
  const [linkState, linkAction, linking] = useActionState(linkSenderToCustomer, null);
  const [linkTarget, setLinkTarget] = useState<string>("");

  return (
    <li className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/10 dark:bg-neutral-900 dark:ring-white/10">
      {/* what arrived */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-lg font-semibold text-neutral-900 dark:text-white">{usdc(row.value)} USDC</div>
          <div className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            from <Hash value={row.from} kind="address" /> · block {row.blockNumber} · indexed {fmt(row.indexedAt)}
          </div>
          <div className="mt-1 text-xs"><Hash value={row.txHash} kind="tx" /></div>
        </div>
        <Pill t={meta.tone}>{row.reason}</Pill>
      </div>

      {/* why it was not matched */}
      <div className="mt-4 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-800/60">
        <div className="text-sm font-semibold text-neutral-900 dark:text-white">{meta.title}</div>
        <p className="mt-1 text-xs leading-5 text-neutral-600 dark:text-neutral-400">{meta.why}</p>
      </div>

      {/* the candidates it weighed */}
      {row.candidates.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
            {row.candidates.length} candidate{row.candidates.length === 1 ? "" : "s"} considered
          </div>
          <ul className="space-y-2">
            {row.candidates.map((c, i) => {
              const delta = c.delta ? BigInt(c.delta) : null;
              return (
                <li key={c.expected_payment_id ?? i} className="rounded-lg border border-neutral-200 p-3 dark:border-white/10">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[13px]">
                    <span className="text-neutral-900 dark:text-neutral-100">
                      {c.expected_payment_id ? <>expected payment #{c.expected_payment_id}</> : <>customer #{c.customer_id}</>}
                      {c.reference && <span className="ml-2 text-neutral-400">{c.reference}</span>}
                    </span>
                    {c.remaining && (
                      <span className="text-neutral-600 dark:text-neutral-400">
                        outstanding {usdc(c.remaining)}
                        {delta !== null && delta !== 0n && (
                          <span className={delta < 0n ? "ml-2 text-amber-700 dark:text-amber-400" : "ml-2 text-brand-primary"}>
                            {delta < 0n ? `short by ${usdc((-delta).toString())}` : `over by ${usdc(delta.toString())}`}
                          </span>
                        )}
                        {delta === 0n && <span className="ml-2 text-emerald-700 dark:text-emerald-400">exact</span>}
                      </span>
                    )}
                  </div>
                  {c.note && <div className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">{c.note}</div>}
                  {c.due_date && <div className="mt-1 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">due {fmt(c.due_date)}</div>}

                  {c.expected_payment_id && (
                    <form action={applyAction} className="mt-3 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="transferId" value={row.id} />
                      <input type="hidden" name="expectedPaymentId" value={c.expected_payment_id} />
                      <label className="text-[11px] text-neutral-500 dark:text-neutral-400">apply</label>
                      <input name="amount" defaultValue={row.value} inputMode="numeric"
                        className="w-36 rounded border border-neutral-300 bg-white px-2 py-1 font-mono text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100" />
                      <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        base units — the whole transfer is {usdc(row.value)}; lower settles a partial, higher records surplus
                      </span>
                      <button type="submit" disabled={applying}
                        className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black">
                        {applying ? "Applying…" : "Apply"}
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
          <Feedback state={applyState} />
        </div>
      )}

      {/* the learning action, framed as learning */}
      <div className="mt-4 rounded-lg border border-dashed border-brand-primary/40 bg-brand-primary/5 p-3">
        <div className="text-xs font-semibold text-neutral-900 dark:text-white">Link this sender to a customer</div>
        <p className="mt-1 text-[11px] leading-5 text-neutral-600 dark:text-neutral-400">
          This is the action that teaches the matcher. Once <span className="font-mono">{row.from.slice(0, 10)}…</span> belongs to a
          customer, a transfer from it for the exact outstanding amount matches automatically — this review will not recur.
        </p>
        <form action={linkAction} className="mt-2 flex flex-wrap items-center gap-2">
          <input type="hidden" name="transferId" value={row.id} />
          <select name="customerId" value={linkTarget} onChange={(e) => setLinkTarget(e.target.value)}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
            <option value="">choose a customer…</option>
            {customers.map((c) => (
              // Labels are not unique. Lead with the id and show a linked
              // address so two customers called the same thing are still
              // distinguishable in the picker.
              <option key={c.id} value={c.id}>
                #{c.id} · {c.label}
                {c.addresses.length > 0 && ` · ${c.addresses[0].slice(0, 10)}…`}
                {c.addresses.length > 1 && ` +${c.addresses.length - 1}`}
                {` · ${c.openCount} open`}
              </option>
            ))}
          </select>
          {row.candidates.some((c) => c.expected_payment_id) && (
            <select name="expectedPaymentId"
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
              <option value="">link only</option>
              {row.candidates.filter((c) => c.expected_payment_id).map((c) => (
                <option key={c.expected_payment_id} value={c.expected_payment_id}>and apply to #{c.expected_payment_id}</option>
              ))}
            </select>
          )}
          <input type="hidden" name="amount" value={row.value} />
          <button type="submit" disabled={linking || !linkTarget}
            className="rounded-md bg-brand-primary px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            {linking ? "Linking…" : "Link sender"}
          </button>
        </form>
        <Feedback state={linkState} />
      </div>

      {/* not a payment */}
      <form action={ignoreAction} className="mt-3 flex items-center gap-3">
        <input type="hidden" name="transferId" value={row.id} />
        <button type="submit" disabled={ignoring}
          className="rounded-md px-3 py-1.5 text-xs font-medium text-neutral-600 ring-1 ring-neutral-300 hover:bg-neutral-50 disabled:opacity-50 dark:text-neutral-300 dark:ring-neutral-700 dark:hover:bg-neutral-800">
          {ignoring ? "Recording…" : "Not a payment"}
        </button>
        <span className="text-[11px] text-neutral-500 dark:text-neutral-400">Kept on record and marked ignored, never deleted.</span>
      </form>
      <Feedback state={ignoreState} />
    </li>
  );
}
