import "server-only";
import type { Abi } from "viem";
import { query } from "@retainer/db";
import { publicClient, config, spendPermissionManagerAbi, toStruct } from "@retainer/chain";

/**
 * Data layer for the merchant dashboard. Nothing here is mocked, seeded or
 * padded, and nothing is cached.
 *
 * The two sources are not interchangeable, and which loader touches which
 * matters: loadContext reads the chain head, loadSnapshot reads permission
 * state from the SpendPermissionManager, and everything else is database-only.
 * Keep it that way -- making every page pay for a multicall it does not render
 * is what previously exhausted the public RPC's rate limit.
 *
 * Every timestamp leaves this module as a full ISO-8601 UTC string. pg hands
 * back timestamptz as a JS Date, and String(date) is what produced
 * "Wed Sep 09 2026" upstream -- so dates are serialised here, once, and never
 * with String().
 */

// @retainer/chain is untyped JS, so its ABI literal types widen to string.
const managerAbi = spendPermissionManagerAbi as unknown as Abi;

/** "unknown" means the RPC could not be read -- never inferred, never guessed. */
export type OnchainState = "active" | "revoked" | "expired" | "not_started" | "not_registered" | "unknown";

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
  fetchedAt: string; chainId: number;
  /** null when the RPC could not be reached -- see loadContext. */
  head: string | null;
  indexer: { lastIndexedBlock: string; updatedAt: string; lag: string | null } | null;
};

export type Snapshot = Context & { permissions: PermissionRow[]; charges: ChargeRow[] };

type Row = Record<string, any>;
const rows = async (sql: string): Promise<Row[]> => ((await query(sql)) as { rows: Row[] }).rows;
const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/**
 * Chain head + indexer checkpoint, for the shell on every route.
 *
 * The head is a freshness indicator, not the substance of any page -- every row
 * shown comes from the database. So a throttled or unreachable RPC degrades it
 * to null and the shell says so, rather than failing the whole render: losing
 * the "how far behind" reading is a much smaller harm than a merchant being
 * unable to see what is overdue. Nothing here is cached; it is simply optional.
 */
export async function loadContext(): Promise<Context> {
  const cfg = config();
  const [ix, head] = await Promise.all([
    rows(`SELECT last_indexed_block, updated_at FROM indexer_state WHERE id = 1`),
    publicClient().getBlockNumber().catch(() => null),
  ]);
  const i = ix[0];
  return {
    fetchedAt: new Date().toISOString(), chainId: cfg.chainId, head: head === null ? null : head.toString(),
    indexer: i
      ? {
          lastIndexedBlock: String(i.last_indexed_block), updatedAt: iso(i.updated_at)!,
          lag: head === null ? null : (head - BigInt(i.last_indexed_block)).toString(),
        }
      : null,
  };
}

/**
 * Charges, attempts and reconciliation evidence -- database only.
 *
 * Deliberately does NOT run the per-permission multicall: only the permissions
 * page shows live on-chain permission state, and making every page pay for ~39
 * eth_calls it never renders is what pushed the public RPC over its rate limit.
 */
export async function loadCharges(): Promise<Context & { charges: ChargeRow[] }> {
  const [ctx, charges, attempts, topics] = await Promise.all([
    loadContext(),
    rows(`SELECT ch.id, ch.permission_id, p.permission_hash, ch.period_start, ch.amount_source, ch.usage_note,
                 ch.amount, ch.confirmed_amount, ch.state::text AS state, ch.last_failure::text AS last_failure,
                 ch.failure_detail, ch.attempts, ch.next_attempt_at, ch.confirmed_tx_hash, ch.confirmed_at, ch.updated_at
            FROM charges ch JOIN permissions p ON p.id = ch.permission_id
           ORDER BY ch.updated_at DESC, ch.id DESC`),
    rows(`SELECT charge_id, nonce, state::text AS state, tx_hash, block_number FROM charge_attempts ORDER BY charge_id, id`),
    rows(`SELECT tx_hash, COUNT(DISTINCT event_name)::int AS n FROM onchain_events GROUP BY tx_hash`),
  ]);
  return { ...ctx, charges: buildCharges(charges, attempts, topics) };
}

/** Shared by loadCharges and loadSnapshot so the two cannot drift apart. */
function buildCharges(charges: Row[], attempts: Row[], topics: Row[]): ChargeRow[] {
  const attemptsByCharge = new Map<string, ChargeRow["attemptSummary"]>();
  for (const a of attempts) {
    const k = String(a.charge_id);
    if (!attemptsByCharge.has(k)) attemptsByCharge.set(k, []);
    attemptsByCharge.get(k)!.push({ nonce: String(a.nonce), state: a.state, tx: a.tx_hash, block: a.block_number == null ? null : String(a.block_number) });
  }
  const topicsByTx = new Map<string, number>(topics.map((t: Row) => [t.tx_hash, Number(t.n)]));
  return charges.map((c: Row) => ({
    id: String(c.id), permissionId: String(c.permission_id), permissionHash: c.permission_hash,
    periodStart: Number(c.period_start), amountSource: c.amount_source, usageNote: c.usage_note,
    requested: c.amount, settled: c.confirmed_amount,
    state: c.state, lastFailure: c.last_failure, failureDetail: c.failure_detail,
    attempts: Number(c.attempts), nextAttemptAt: iso(c.next_attempt_at),
    confirmedTx: c.confirmed_tx_hash, confirmedAt: iso(c.confirmed_at), updatedAt: iso(c.updated_at)!,
    attemptSummary: attemptsByCharge.get(String(c.id)) ?? [],
    topicsIndexed: c.confirmed_tx_hash ? (topicsByTx.get(c.confirmed_tx_hash) ?? 0) : 0,
  }));
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
    ? await client
        .multicall({
          allowFailure: true,
          contracts: structs.flatMap((st: ReturnType<typeof toStruct>) => [
            { address: cfg.manager as `0x${string}`, abi: managerAbi, functionName: "isRevoked", args: [st] },
            { address: cfg.manager as `0x${string}`, abi: managerAbi, functionName: "isApproved", args: [st] },
            { address: cfg.manager as `0x${string}`, abi: managerAbi, functionName: "getCurrentPeriod", args: [st] },
          ]),
        })
        // allowFailure already turns a dead transport into per-call failures, so
        // this only covers an error raised before the request is even attempted.
        .catch(() => [])
    : [];

  const permissions: PermissionRow[] = perms.map((r: Row, i: number) => {
    // isRevoked and isApproved are pure views that cannot revert for a
    // well-formed permission, so a failure on either means the chain was not
    // read at all. Treat that as unknown rather than as `false`: defaulting to
    // false would report a live permission as "signed, not registered", which
    // is worse than admitting the reading is missing. (getCurrentPeriod is
    // excluded -- it reverts legitimately outside the active window.)
    const read = mc[i * 3]?.status === "success" && mc[i * 3 + 1]?.status === "success";
    const revoked = read && mc[i * 3].result === true;
    const approved = read && mc[i * 3 + 1].result === true;
    const cur = mc[i * 3 + 2]?.status === "success" ? (mc[i * 3 + 2].result as { start: number; end: number; spend: bigint }) : null;
    const start = Number(r.start_ts), end = Number(r.end_ts);
    // Same order as packages/chain/src/classify.js: revoked, expired, not started, not registered.
    const onchain: OnchainState = !read
      ? "unknown"
      : revoked ? "revoked" : now >= end ? "expired" : now < start ? "not_started" : !approved ? "not_registered" : "active";
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

  const chargeRows = buildCharges(charges, attempts, topics);

  return { ...ctx, permissions, charges: chargeRows };
}

/* ------------------------------------------------ phase 2: expected payments */

export type ExpectedRow = {
  id: string; customerId: string; customerLabel: string;
  amountExpected: string; amountSettled: string; outstanding: string;
  state: string; fulfilment: string; dueDate: string; reference: string | null;
  chargeId: string | null; chargeState: string | null; chargeTx: string | null;
  matchCount: number;
};

export type ReviewRow = {
  id: string; txHash: string; from: string; to: string; value: string;
  blockNumber: string; indexedAt: string; reason: string;
  candidates: {
    expected_payment_id?: string; customer_id?: string; reference?: string | null;
    amount_expected?: string; remaining?: string; delta?: string; due_date?: string;
    fulfilment?: string; note?: string;
  }[];
};

export type CustomerRow = { id: string; label: string; addresses: string[]; openCount: number };

export async function reviewCount(): Promise<number> {
  return Number((await rows(`SELECT count(*)::int AS c FROM incoming_transfers WHERE match_state = 'needs_review'`))[0].c);
}

export async function loadExpectedPayments(): Promise<ExpectedRow[]> {
  const r = await rows(`
    SELECT ep.id, ep.customer_id, c.label AS customer_label,
           ep.amount_expected, ep.amount_settled,
           (ep.amount_expected - ep.amount_settled) AS outstanding,
           ep.state::text AS state, ep.fulfilment::text AS fulfilment, ep.due_date, ep.reference,
           ch.id AS charge_id, ch.state::text AS charge_state, ch.confirmed_tx_hash AS charge_tx,
           (SELECT count(*)::int FROM payment_matches pm WHERE pm.expected_payment_id = ep.id) AS match_count
      FROM expected_payments ep
      JOIN customers c ON c.id = ep.customer_id
      LEFT JOIN charges ch ON ch.expected_payment_id = ep.id
     ORDER BY CASE ep.state WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 WHEN 'partially_paid' THEN 2
                            WHEN 'upcoming' THEN 3 WHEN 'paid' THEN 4 ELSE 5 END,
              ep.due_date DESC`);
  return r.map((x: Row) => ({
    id: String(x.id), customerId: String(x.customer_id), customerLabel: x.customer_label,
    amountExpected: x.amount_expected, amountSettled: x.amount_settled, outstanding: x.outstanding,
    state: x.state, fulfilment: x.fulfilment, dueDate: iso(x.due_date)!, reference: x.reference,
    chargeId: x.charge_id == null ? null : String(x.charge_id),
    chargeState: x.charge_state, chargeTx: x.charge_tx, matchCount: Number(x.match_count),
  }));
}

export async function loadReviewQueue(): Promise<ReviewRow[]> {
  const r = await rows(`
    SELECT id, tx_hash, from_address, to_address, value, block_number, indexed_at,
           match_reason::text AS reason, candidates
      FROM incoming_transfers
     WHERE match_state = 'needs_review'
     ORDER BY block_number DESC, log_index DESC`);
  return r.map((x: Row) => ({
    id: String(x.id), txHash: x.tx_hash, from: x.from_address, to: x.to_address,
    value: x.value, blockNumber: String(x.block_number), indexedAt: iso(x.indexed_at)!,
    reason: x.reason, candidates: x.candidates ?? [],
  }));
}

/**
 * Customers for the link-sender picker. Ordered by open obligations first,
 * because linking a sender to a customer with nothing outstanding is the rare
 * case; the addresses come back so the UI can tell two customers apart when
 * they share a label, which the id alone does not make obvious.
 */
export async function loadCustomers(): Promise<CustomerRow[]> {
  const r = await rows(`
    SELECT c.id, c.label,
           COALESCE(array_remove(array_agg(DISTINCT ca.address), NULL), '{}') AS addresses,
           (SELECT count(*)::int FROM expected_payments ep
             WHERE ep.customer_id = c.id
               AND ep.state IN ('upcoming','due','overdue','partially_paid')) AS open_count
      FROM customers c LEFT JOIN customer_addresses ca ON ca.customer_id = c.id
     GROUP BY c.id, c.label
     ORDER BY open_count DESC, c.id DESC`);
  return r.map((x: Row) => ({ id: String(x.id), label: x.label, addresses: x.addresses ?? [], openCount: Number(x.open_count) }));
}
