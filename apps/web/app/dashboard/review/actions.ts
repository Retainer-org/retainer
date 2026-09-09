"use server";

import { revalidatePath } from "next/cache";
import { resolveReview } from "../../../../worker/src/matcher.js";

/**
 * The five review actions. These are the ONLY mutations anywhere in the
 * dashboard; every other page is read-only.
 *
 * Each one goes through resolveReview, which is the same code path the CLI
 * uses, so the UI cannot apply a match the engine would not. In particular the
 * UI has no way to write `auto_matched` -- a human resolution is always
 * recorded with confidence `manual`, so the audit trail distinguishes what the
 * matcher decided from what a person decided.
 */

type Result = { ok: true; detail: string } | { ok: false; error: string };

const asAmount = (v: FormDataEntryValue | null): string | undefined => {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  if (!/^\d+$/.test(s)) throw new Error("amount must be a whole number of base units");
  return s;
};

/** Apply in full, as a partial, or with surplus -- one path, three intents. */
export async function applyToPayment(_prev: Result | null, form: FormData): Promise<Result> {
  try {
    const out = await resolveReview({
      transferId: String(form.get("transferId")),
      action: "apply",
      expectedPaymentId: String(form.get("expectedPaymentId")),
      amount: asAmount(form.get("amount")),
      linkSender: undefined, by: "review:dashboard",
    });
    revalidatePath("/dashboard/review");
    revalidatePath("/dashboard/expected");
    const surplus = BigInt(out.surplus ?? "0");
    return { ok: true, detail: `Applied ${out.applied} to expected payment ${out.expectedPaymentId}` +
      (out.paid ? " — now fully settled" : " — still partially paid") +
      (surplus > 0n ? `, ${out.surplus} recorded as surplus` : "") };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Not a payment: record the judgement rather than deleting the transfer. */
export async function markNotAPayment(_prev: Result | null, form: FormData): Promise<Result> {
  try {
    await resolveReview({ transferId: String(form.get("transferId")), action: "ignore",
      expectedPaymentId: undefined, amount: undefined, linkSender: undefined, by: "review:dashboard" });
    revalidatePath("/dashboard/review");
    return { ok: true, detail: "Marked as not a payment. The transfer stays on record, ignored." };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/**
 * The learning action. Linking a sender to a customer is what turns a review
 * into a rule: an identical transfer from this address will auto-match next
 * time, because the sender becomes "known" for that customer.
 */
export async function linkSenderToCustomer(_prev: Result | null, form: FormData): Promise<Result> {
  try {
    const customerId = String(form.get("customerId") ?? "");
    if (!customerId) return { ok: false, error: "choose a customer to link this sender to" };
    const expectedPaymentId = String(form.get("expectedPaymentId") ?? "");

    if (expectedPaymentId) {
      // Link and apply together: the common case is "yes, this is them, and
      // this is what it pays for".
      const out = await resolveReview({
        transferId: String(form.get("transferId")), action: "apply",
        expectedPaymentId, amount: asAmount(form.get("amount")),
        linkSender: customerId, by: "review:dashboard",
      });
      revalidatePath("/dashboard/review");
      revalidatePath("/dashboard/expected");
      return { ok: true, detail: `Sender linked, and ${out.applied} applied to expected payment ${out.expectedPaymentId}. Identical transfers from this address will match automatically from now on.` };
    }

    // Link only. The transfer stays in review, but re-running the matcher (or
    // the next identical transfer) will now see a known sender.
    await resolveReview({
      transferId: String(form.get("transferId")), action: "ignore",
      expectedPaymentId: undefined, amount: undefined,
      linkSender: customerId, by: "review:dashboard",
    });
    revalidatePath("/dashboard/review");
    return { ok: true, detail: "Sender linked to that customer. Identical transfers from this address will match automatically from now on." };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
