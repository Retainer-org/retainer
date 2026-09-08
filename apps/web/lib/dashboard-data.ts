import "server-only";
import type { Abi } from "viem";
import { query } from "@retainer/db";
import { publicClient, config, spendPermissionManagerAbi, toStruct } from "@retainer/chain";

/**
 * Data layer for the merchant dashboard. Reads the real database and the live
 * chain at request time. Nothing here is mocked, seeded or padded.
 *
 * Every timestamp leaves this module as a full ISO-8601 UTC string. pg hands
 * back timestamptz as a JS Date, and String(date) is what produced
 * "Wed Sep 09 2026" upstream -- so dates are serialised here, once, and never
 * with String().
 */

// @retainer/chain is untyped JS, so its ABI literal types widen to string.
const managerAbi = spendPermissionManagerAbi as unknown as Abi;

export type OnchainState = "active" | "revoked" | "expired" | "not_started" | "not_registered";

export type PermissionRow = {
  id: string; hash: string; account: string; recipient: string;
  allowance: string; periodSeconds: number; start: number; end: number;
  registered: boolean; revokedAt: string | null; approvedTx: string | null;
  onchain: OnchainState;
  periodStart: number | null; periodEnd: number | null;
  spentThisPeriod: string | null; remainingThisPeriod: string | null;
  lastActivity: string;            // ISO; drives default ordering
  chargeCount: number;
};

export type ChargeRow = {
  id: string; permissionId: string; permissionHash: string;
  periodStart: number; amountSource: "fixed" | "usage"; usageNote: string | null;
  requested: string; settled: string | null;
  state: string; lastFailure: string | null; failureDetail: string | null;
  attempts: number; nextAttemptAt: string | null;
  confirmedTx: string | null; confirmedAt: string | null; updatedAt: string;
  attemptSummary: { nonce: string; state: string; tx: string; block: string | null }[];
  topicsIndexed: number;
};

export type Context = {
  fetchedAt: string; chainId: number; head: string;
  indexer: { lastIndexedBlock: string; updatedAt: string; lag: string } | null;
};

export type Snapshot = Context & { permissions: PermissionRow[]; charges: ChargeRow[] };

type Row = Record<string, any>;
const rows = async (sql: string): Promise<Row[]> => ((await query(sql)) as { rows: Row[] }).rows;
const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/** Chain head + indexer checkpoint. Cheap; used by the dashboard shell on every route. */
export async function loadContext(): Promise<Context> {
  const cfg = config();
  const [ix, head] = await Promise.all([
    rows(`SELECT last_indexed_block, updated_at FROM indexer_state WHERE id = 1`),
    publicClient().getBlockNumber(),
  ]);
  const i = ix[0];
  return {
    fetchedAt: new Date().toISOString(), chainId: cfg.chainId, head: head.toString(),
    indexer: i ? { lastIndexedBlock: String(i.last_indexed_block), updatedAt: iso(i.updated_at)!, lag: (head - BigInt(i.last_indexed_block)).toString() } : null,
  };
}

export async function loadSnapshot(): Promise<Snapshot> {
  const cfg = config();
  const client = publicClient();
  const now = Math.floor(Date.now() / 1000);

  const [ctx, perms, charges, attempts, topics] = await Promise.all([
    loadContext(),
    // Ordered by most recent activity: the latest charge update on the
    // permission, else its revocation, registration or signature. Test
    // leftovers with no charges sink to the bottom but stay reachable.
    rows(`SELECT p.id, p.permission_hash, p.account, p.recipient, p.allowance, p.period_seconds, p.start_ts, p.end_ts,
                 p.salt, p.extra_data, p.spender, p.token, p.approved_tx_hash, p.revoked_at,
                 COALESCE(c.last_update, p.revoked_at, p.approved_at, p.signed_at) AS last_activity,
                 COALESCE(c.n, 0)::int AS charge_count
            FROM permissions p
            LEFT JOIN LATERAL (SELECT MAX(updated_at) AS last_update, COUNT(*) AS n FROM charges WHERE permission_id = p.id) c ON true
           ORDER BY last_activity DESC NULLS LAST, p.id DESC`),
    rows(`SELECT ch.id, ch.permission_id, p.permission_hash, ch.period_start, ch.amount_source, ch.usage_note,
                 ch.amount, ch.confirmed_amount, ch.state::text AS state, ch.last_failure::text AS last_failure,
                 ch.failure_detail, ch.attempts, ch.next_attempt_at, ch.confirmed_tx_hash, ch.confirmed_at, ch.updated_at
            FROM charges ch JOIN permissions p ON p.id = ch.permission_id
           ORDER BY ch.updated_at DESC, ch.id DESC`),
    rows(`SELECT charge_id, nonce, state::text AS state, tx_hash, block_number FROM charge_attempts ORDER BY charge_id, id`),
    rows(`SELECT tx_hash, COUNT(DISTINCT event_name)::int AS n FROM onchain_events GROUP BY tx_hash`),
  ]);

  // Live on-chain state, batched through multicall3. getCurrentPeriod reverts
  // outside the window, so allowFailure and derive the window from timestamps.
  const structs = perms.map((r: Row) => toStruct({
    account: r.account, spender: r.spender, token: r.token, allowance: r.allowance,
    period: r.period_seconds, start: r.start_ts, end: r.end_ts, salt: r.salt, extraData: r.extra_data,
  }));
  const mc = structs.length
    ? await client.multicall({
        allowFailure: true,
        contracts: structs.flatMap((st: ReturnType<typeof toStruct>) => [
          { address: cfg.manager as `0x${string}`, abi: managerAbi, functionName: "isRevoked", args: [st] },
          { address: cfg.manager as `0x${string}`, abi: managerAbi, functionName: "isApproved", args: [st] },
          { address: cfg.manager as `0x${string}`, abi: managerAbi, functionName: "getCurrentPeriod", args: [st] },
        ]),
      })
    : [];

  const permissions: PermissionRow[] = perms.map((r: Row, i: number) => {
    const revoked = mc[i * 3]?.status === "success" && mc[i * 3].result === true;
    const approved = mc[i * 3 + 1]?.status === "success" && mc[i * 3 + 1].result === true;
    const cur = mc[i * 3 + 2]?.status === "success" ? (mc[i * 3 + 2].result as { start: number; end: number; spend: bigint }) : null;
    const start = Number(r.start_ts), end = Number(r.end_ts);
    // Same order as packages/chain/src/classify.js: revoked, expired, not started, not registered.
    const onchain: OnchainState =
      revoked ? "revoked" : now >= end ? "expired" : now < start ? "not_started" : !approved ? "not_registered" : "active";
    const allowance = BigInt(r.allowance);
    const spent = onchain === "active" && cur ? BigInt(cur.spend) : null;
    return {
      id: String(r.id), hash: r.permission_hash, account: r.account, recipient: r.recipient,
      allowance: r.allowance, periodSeconds: Number(r.period_seconds), start, end,
      registered: approved, revokedAt: iso(r.revoked_at), approvedTx: r.approved_tx_hash,
      onchain,
      periodStart: cur ? Number(cur.start) : null, periodEnd: cur ? Number(cur.end) : null,
      spentThisPeriod: spent === null ? null : spent.toString(),
      remainingThisPeriod: spent === null ? null : (allowance - spent).toString(),
      lastActivity: iso(r.last_activity) ?? "", chargeCount: Number(r.charge_count),
    };
  });

  const attemptsByCharge = new Map<string, ChargeRow["attemptSummary"]>();
  for (const a of attempts) {
    const k = String(a.charge_id);
    if (!attemptsByCharge.has(k)) attemptsByCharge.set(k, []);
    attemptsByCharge.get(k)!.push({ nonce: String(a.nonce), state: a.state, tx: a.tx_hash, block: a.block_number == null ? null : String(a.block_number) });
  }
  const topicsByTx = new Map<string, number>(topics.map((t: Row) => [t.tx_hash, Number(t.n)]));

  const chargeRows: ChargeRow[] = charges.map((c: Row) => ({
    id: String(c.id), permissionId: String(c.permission_id), permissionHash: c.permission_hash,
    periodStart: Number(c.period_start), amountSource: c.amount_source, usageNote: c.usage_note,
    requested: c.amount, settled: c.confirmed_amount,
    state: c.state, lastFailure: c.last_failure, failureDetail: c.failure_detail,
    attempts: Number(c.attempts), nextAttemptAt: iso(c.next_attempt_at),
    confirmedTx: c.confirmed_tx_hash, confirmedAt: iso(c.confirmed_at), updatedAt: iso(c.updated_at)!,
    attemptSummary: attemptsByCharge.get(String(c.id)) ?? [],
    topicsIndexed: c.confirmed_tx_hash ? (topicsByTx.get(c.confirmed_tx_hash) ?? 0) : 0,
  }));

  return { ...ctx, permissions, charges: chargeRows };
}
