import "server-only";
import { query } from "@retainer/db";
import type { Abi } from "viem";
import { publicClient, config, spendPermissionManagerAbi, toStruct } from "@retainer/chain";

// @retainer/chain is untyped JS, so its ABI literal types are widened to string.
// The runtime shape is a valid ABI; this only tells the type checker so.
const managerAbi = spendPermissionManagerAbi as unknown as Abi;

/**
 * Data layer for the merchant dashboard. Reads the real database and the live
 * chain at request time. Nothing here is mocked, seeded or padded: if a table
 * is empty the page says so.
 *
 * Two sources, kept distinct on the page:
 *   - the database, which is what Retainer *believes* (charge state, attempts,
 *     what has been reconciled)
 *   - the chain, which is what is *true* (is the permission revoked / registered,
 *     how much of this period's allowance is already spent)
 */

export type OnchainState = "active" | "revoked" | "expired" | "not_started" | "not_registered";

export type PermissionRow = {
  id: string; hash: string; account: string; recipient: string;
  allowance: string; periodSeconds: number; start: number; end: number;
  registered: boolean; revokedAt: string | null; approvedTx: string | null;
  onchain: OnchainState;
  periodStart: number | null; periodEnd: number | null;
  spentThisPeriod: string | null; remainingThisPeriod: string | null;
};

export type ChargeRow = {
  id: string; permissionId: string; permissionHash: string;
  periodStart: number; amountSource: "fixed" | "usage"; usageNote: string | null;
  requested: string; settled: string | null;
  state: string; lastFailure: string | null; failureDetail: string | null;
  attempts: number; nextAttemptAt: string | null;
  confirmedTx: string | null; confirmedAt: string | null;
  attemptSummary: { nonce: string; state: string; tx: string; block: string | null }[];
  topicsIndexed: number;
};

export type Snapshot = {
  fetchedAt: string;
  chainId: number; head: string;
  indexer: { lastIndexedBlock: string; updatedAt: string; lag: string } | null;
  permissions: PermissionRow[];
  charges: ChargeRow[];
};

const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

type Row = Record<string, any>;
const rows = async (sql: string): Promise<Row[]> => ((await query(sql)) as { rows: Row[] }).rows;

export async function loadSnapshot(): Promise<Snapshot> {
  const cfg = config();
  const client = publicClient();
  const now = Math.floor(Date.now() / 1000);

  const [perms, charges, attempts, topics, indexer, head] = await Promise.all([
    rows(`SELECT id, permission_hash, account, recipient, allowance, period_seconds, start_ts, end_ts,
                  salt, extra_data, spender, token, approved_tx_hash, revoked_at
             FROM permissions ORDER BY id`),
    rows(`SELECT ch.id, ch.permission_id, p.permission_hash, ch.period_start, ch.amount_source, ch.usage_note,
                  ch.amount, ch.confirmed_amount, ch.state::text AS state, ch.last_failure::text AS last_failure,
                  ch.failure_detail, ch.attempts, ch.next_attempt_at, ch.confirmed_tx_hash, ch.confirmed_at
             FROM charges ch JOIN permissions p ON p.id = ch.permission_id ORDER BY ch.id`),
    rows(`SELECT charge_id, nonce, state::text AS state, tx_hash, block_number
             FROM charge_attempts ORDER BY charge_id, id`),
    rows(`SELECT tx_hash, COUNT(DISTINCT event_name)::int AS n FROM onchain_events GROUP BY tx_hash`),
    rows(`SELECT last_indexed_block, updated_at FROM indexer_state WHERE id = 1`),
    client.getBlockNumber(),
  ]);

  // --- live on-chain state per permission, batched through multicall3 --------
  // getCurrentPeriod reverts outside the permission's window, so allowFailure
  // and derive not_started / expired from the timestamps instead.
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
    // Same order as packages/chain/src/classify.js, so the dashboard and the
    // engine never disagree about a permission's state.
    const onchain: OnchainState =
      revoked ? "revoked" : now >= end ? "expired" : now < start ? "not_started" : !approved ? "not_registered" : "active";
    const allowance = BigInt(r.allowance);
    const spent = onchain === "active" && cur ? BigInt(cur.spend) : null;
    return {
      id: String(r.id), hash: r.permission_hash, account: r.account, recipient: r.recipient,
      allowance: r.allowance, periodSeconds: Number(r.period_seconds), start, end,
      registered: approved, revokedAt: s(r.revoked_at), approvedTx: r.approved_tx_hash,
      onchain,
      periodStart: cur ? Number(cur.start) : null, periodEnd: cur ? Number(cur.end) : null,
      spentThisPeriod: spent === null ? null : spent.toString(),
      remainingThisPeriod: spent === null ? null : (allowance - spent).toString(),
    };
  });

  // --- charges, with attempt history and reconciliation evidence -------------
  const attemptsByCharge = new Map<string, ChargeRow["attemptSummary"]>();
  for (const a of attempts) {
    const k = String(a.charge_id);
    if (!attemptsByCharge.has(k)) attemptsByCharge.set(k, []);
    attemptsByCharge.get(k)!.push({ nonce: String(a.nonce), state: a.state, tx: a.tx_hash, block: s(a.block_number) });
  }
  const topicsByTx = new Map<string, number>(topics.map((t: Row) => [t.tx_hash, Number(t.n)]));

  const chargeRows: ChargeRow[] = charges.map((c: Row) => ({
    id: String(c.id), permissionId: String(c.permission_id), permissionHash: c.permission_hash,
    periodStart: Number(c.period_start), amountSource: c.amount_source, usageNote: c.usage_note,
    requested: c.amount, settled: c.confirmed_amount,
    state: c.state, lastFailure: c.last_failure, failureDetail: c.failure_detail,
    attempts: Number(c.attempts), nextAttemptAt: s(c.next_attempt_at),
    confirmedTx: c.confirmed_tx_hash, confirmedAt: s(c.confirmed_at),
    attemptSummary: attemptsByCharge.get(String(c.id)) ?? [],
    topicsIndexed: c.confirmed_tx_hash ? (topicsByTx.get(c.confirmed_tx_hash) ?? 0) : 0,
  }));

  const ix = indexer[0];
  return {
    fetchedAt: new Date().toISOString(),
    chainId: cfg.chainId, head: head.toString(),
    indexer: ix ? { lastIndexedBlock: String(ix.last_indexed_block), updatedAt: String(ix.updated_at), lag: (head - BigInt(ix.last_indexed_block)).toString() } : null,
    permissions, charges: chargeRows,
  };
}
