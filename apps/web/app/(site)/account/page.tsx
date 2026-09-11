import type { Metadata } from "next";
import { AccountView } from "@/components/account/account-view";

export const metadata: Metadata = { title: "Your permissions — Retainer" };

/**
 * Where a customer comes back to: what each permission they signed allows, what has been
 * taken under it, and the controls to fund, withdraw and cancel. Scoped to the wallet that
 * signs in -- see AccountView and /api/me/permissions.
 */
export default function Page() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:px-8 md:py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-white">Your permissions</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        See exactly what each payment permission allows, every charge taken under it, and cancel any of them. Base Sepolia test deployment.
      </p>
      <div className="mt-8"><AccountView /></div>
    </div>
  );
}
