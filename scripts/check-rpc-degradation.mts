/**
 * The dashboard reads two sources: the database (obligations, charges,
 * transfers) and the chain (permission state, head). The database is the
 * substance; the chain is corroboration. When the RPC is throttled or down the
 * pages must still render what the database knows, and must say "unknown" for
 * what it could not read -- never infer a value from the absence of a reading.
 *
 * That second half matters more than it looks. viem's multicall with
 * allowFailure turns a dead transport into per-call failures rather than
 * throwing, so a naive `result === true` check silently reports every live
 * permission as "signed, not registered". This check exists because that bug
 * was real.
 *
 * Run: npm run check:degradation
 */
import { loadContext, loadSnapshot, loadExpectedPayments } from "../apps/web/lib/dashboard-data";

let pass = 0, fail = 0;
const check = (l: string, ok: boolean, d = "") => { ok ? pass++ : fail++; console.log(`  [${ok ? "PASS" : "FAIL"}] ${l}${d ? ` — ${d}` : ""}`); };

const dead = process.env.BASE_SEPOLIA_RPC_URL?.includes("127.0.0.1:9") ?? false;
console.log(dead ? "=== RPC pointed at a dead port ===" : "=== RPC reachable (negative control) ===");

const ctx = await loadContext();
const snap = await loadSnapshot();
const states = [...new Set(snap.permissions.map((p) => p.onchain))];
console.log(`  head=${ctx.head ?? "null"} lag=${ctx.indexer?.lag ?? "null"} permissions=${snap.permissions.length} states=${states.join(",")}`);

if (dead) {
  check("head is null, not stale or invented", ctx.head === null);
  check("lag is null rather than computed from a missing head", ctx.indexer?.lag === null);
  check("the database checkpoint still renders", !!ctx.indexer?.lastIndexedBlock, ctx.indexer?.lastIndexedBlock);
  check("permissions still list", snap.permissions.length > 0, `${snap.permissions.length} rows`);
  check('every on-chain state reads "unknown", never a guess', states.every((s) => s === "unknown"), states.join(","));
  check("registered is not asserted without a reading", snap.permissions.every((p) => !p.registered));
  check("spend-this-period is null, not 0", snap.permissions.every((p) => p.spentThisPeriod === null));
  const eps = await loadExpectedPayments();
  check("expected payments are unaffected — they never needed the chain", eps.length > 0, `${eps.length} rows`);
} else {
  check('a reachable RPC yields real states, never "unknown"', !states.includes("unknown"), states.join(","));
  check("a reachable RPC yields a real head", ctx.head !== null, String(ctx.head));
}

console.log(`\n${dead ? "degraded" : "control"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
