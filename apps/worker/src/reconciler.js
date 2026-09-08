import { parseEventLogs } from 'viem';
import { publicClient, config, spendPermissionManagerAbi, spendRouterAbi } from '@retainer/chain';
import { query, tx, audit } from '@retainer/db';

const CONFIRMATIONS = 3n;

/**
 * Index SpendPermissionUsed (manager) and SpendRouted (router), then confirm
 * charges.
 *
 * A charge is marked paid ONLY here, and only when BOTH events are present for
 * the same transaction at sufficient confirmations. Never on broadcast, never
 * on receipt alone -- a receipt says the transaction executed, the events say
 * the money actually moved to the recipient we intended.
 */
export async function indexEvents({ fromBlock } = {}) {
  const cfg = config();
  const client = publicClient();
  const head = await client.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;

  const { rows } = await query('SELECT last_indexed_block FROM indexer_state WHERE id = 1');
  let start = fromBlock !== undefined ? BigInt(fromBlock)
            : rows.length ? BigInt(rows[0].last_indexed_block) + 1n
            : safeHead > 5000n ? safeHead - 5000n : 0n;

  if (start > safeHead) return { indexed: 0, from: Number(start), to: Number(safeHead) };

  let indexed = 0;
  // Chunked so a wide backfill cannot trip provider log limits.
  for (let lo = start; lo <= safeHead; lo += 900n) {
    const hi = (lo + 899n) > safeHead ? safeHead : lo + 899n;
    const logs = await client.getLogs({
      address: [cfg.manager, cfg.router], fromBlock: lo, toBlock: hi,
    });
    const parsed = parseEventLogs({
      abi: [...spendPermissionManagerAbi, ...spendRouterAbi], logs,
      eventName: ['SpendPermissionUsed', 'SpendRouted'],
    });
    for (const ev of parsed) {
      const a = ev.args ?? {};
      await query(
        `INSERT INTO onchain_events
           (event_name, tx_hash, log_index, block_number, permission_hash, account, spender, recipient, token, value, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [ev.eventName, ev.transactionHash, ev.logIndex, ev.blockNumber.toString(),
         (a.hash ?? a.permissionHash ?? null), (a.account ?? null), (a.spender ?? null),
         (a.recipient ?? null), (a.token ?? null),
         (a.periodSpend?.spend ?? a.value ?? null)?.toString() ?? null,
         JSON.stringify(ev, (k, v) => (typeof v === 'bigint' ? v.toString() : v))]);
      indexed++;
    }
    await query(
      `INSERT INTO indexer_state (id, last_indexed_block) VALUES (1,$1)
       ON CONFLICT (id) DO UPDATE SET last_indexed_block = $1, updated_at = now()`,
      [hi.toString()]);
  }
  return { indexed, from: Number(start), to: Number(safeHead) };
}

/** Promote mined attempts to confirmed once both events are indexed. */
export async function confirmCharges() {
  const { rows } = await query(`
    SELECT a.id AS attempt_id, a.charge_id, a.tx_hash, a.amount, ch.permission_id, p.permission_hash, p.recipient
      FROM charge_attempts a
      JOIN charges ch    ON ch.id = a.charge_id
      JOIN permissions p ON p.id = ch.permission_id
     WHERE a.state = 'mined_success' AND ch.state <> 'confirmed'`);

  const confirmed = [];
  for (const r of rows) {
    const { rows: evs } = await query(
      `SELECT event_name, value, recipient FROM onchain_events WHERE tx_hash = $1`, [r.tx_hash]);

    const used = evs.find(e => e.event_name === 'SpendPermissionUsed');
    const routed = evs.find(e => e.event_name === 'SpendRouted');
    if (!used || !routed) continue;  // not both present yet -- stay unconfirmed

    // The router must have paid the recipient we actually intended.
    if (routed.recipient && routed.recipient.toLowerCase() !== r.recipient.toLowerCase()) {
      await tx(async (c) => {
        await audit(c, { actor: 'reconciler', event: 'charge.recipient_mismatch',
          permissionId: r.permission_id, chargeId: r.charge_id, txHash: r.tx_hash,
          detail: { expected: r.recipient, saw: routed.recipient } });
      });
      continue;
    }

    await tx(async (c) => {
      await c.query(
        `UPDATE charges SET state='confirmed', confirmed_tx_hash=$2, confirmed_at=now(),
                confirmed_amount=$3, updated_at=now() WHERE id=$1`,
        [r.charge_id, r.tx_hash, routed.value]);
      await audit(c, { actor: 'reconciler', event: 'charge.confirmed',
        permissionId: r.permission_id, chargeId: r.charge_id, txHash: r.tx_hash,
        detail: { routedValue: routed.value, spendEvent: used.value } });
    });
    confirmed.push({ chargeId: r.charge_id, txHash: r.tx_hash, value: routed.value });
  }
  return confirmed;
}
