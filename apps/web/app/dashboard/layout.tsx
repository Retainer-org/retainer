import { Shell } from "@/components/dashboard/shell";
import { loadContext, reviewCount } from "@/lib/dashboard-data";
import { reviewWritesEnabled } from "../../../worker/src/matcher.js";

// Dashboard chrome: its own shell, no marketing nav or footer. Context (chain,
// head, indexer lag, render time) is fetched here so every route's top bar
// carries it without each page repeating the query.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [ctx, review] = await Promise.all([loadContext(), reviewCount()]);
  return <Shell ctx={ctx} reviewCount={review} canWrite={reviewWritesEnabled()}>{children}</Shell>;
}
