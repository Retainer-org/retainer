import { parseAbiItem } from 'viem';
import { publicClient, config } from '@retainer/chain';
import { query, tx } from '@retainer/db';

/**
 * Watch mode: index incoming token transfers to the merchant's registered
 * receiving addresses.
 *
 * This exists because a Safe multisig can never be the account of a spend
 * permission -- SpendPermissionManager._execute hard-casts the payer to
 * CoinbaseSmartWallet and calls execute(target,value,data), which a Safe does
 * not expose. DAOs and treasuries paying from multisigs are reachable only by
 * watching for their transfers.
 */

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

// Same depth as the charge reconciler, so both halves of the system agree on
// what "confirmed" means.
const CONFIRMATIONS = 3n;
const CURSOR = 'usdc-transfers';
const CHUNK = 900n;

async function cursor(chainId, safeHead) {
  const { rows } = await query('SELECT last_indexed_block FROM watch_cursors WHERE name = $1', [CURSOR]);
  if (rows.length) return BigInt(rows[0].last_indexed_block) + 1n;
  // First run: start a short way back rather than scanning all of history.
  const start = safeHead > 5000n ? safeHead - 5000n : 0n;
  await query(
    `INSERT INTO watch_cursors (name, chain_id, last_indexed_block) VALUES ($1,$2,$3)
     ON CONFLICT (name) DO NOTHING`, [CURSOR, chainId, (start - 1n).toString()]);
  return start;
}

/**
 * Index new transfers into `incoming_transfers` as `pending`. Classification
 * is the matcher's job, deliberately separate: indexing is about what the
 * chain says, matching is about what it means.
 */
export async function indexIncomingTransfers({ fromBlock } = {}) {
  const cfg = config();
  const client = publicClient();

  const watched = (await query(
    'SELECT address FROM watched_addresses WHERE active AND chain_id = $1', [cfg.chainId])).rows;
  if (!watched.length) return { indexed: 0, reason: 'no watched addresses registered' };

  const head = await client.getBlockNumber();
  const safeHead = head > CONFIRMATIONS ? head - CONFIRMATIONS : 0n;
  let start = fromBlock !== undefined ? BigInt(fromBlock) : await cursor(cfg.chainId, safeHead);
  if (start > safeHead) return { indexed: 0, from: Number(start), to: Number(safeHead) };

  let indexed = 0;
  for (let lo = start; lo <= safeHead; lo += CHUNK) {
    const hi = lo + CHUNK - 1n > safeHead ? safeHead : lo + CHUNK - 1n;

    // One getLogs per watched address: `to` is an indexed topic, so this is a
    // topic filter rather than a full scan.
    for (const w of watched) {
      const logs = await client.getLogs({
        address: cfg.usdc, event: TRANSFER, args: { to: w.address }, fromBlock: lo, toBlock: hi,
      });
      for (const l of logs) {
        const { rowCount } = await query(
          `INSERT INTO incoming_transfers
             (chain_id, tx_hash, log_index, block_number, block_hash, token, from_address, to_address, value)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (tx_hash, log_index) DO NOTHING`,
          [cfg.chainId, l.transactionHash, l.logIndex, l.blockNumber.toString(), l.blockHash,
           cfg.usdc, l.args.from, l.args.to, l.args.value.toString()]);
        indexed += rowCount ?? 0;
      }
    }

    await query(
      `INSERT INTO watch_cursors (name, chain_id, last_indexed_block) VALUES ($1,$2,$3)
       ON CONFLICT (name) DO UPDATE SET last_indexed_block = $3, updated_at = now()`,
      [CURSOR, cfg.chainId, hi.toString()]);
  }
  return { indexed, from: Number(start), to: Number(safeHead) };
}

/**
 * Detect a reorg beneath already-indexed transfers.
 *
 * Storing block_hash makes a reorg detectable; it does not make it handled.
 * If this reports anything, the affected transfers may no longer exist on
 * chain and their matches need review by hand. Deep reorg handling is not
 * built, and that gap is stated on the limitations page rather than implied
 * away.
 */
export async function detectReorgs({ depth = 200 } = {}) {
  const client = publicClient();
  const { rows } = await query(
    `SELECT DISTINCT block_number, block_hash FROM incoming_transfers
      ORDER BY block_number DESC LIMIT $1`, [depth]);
  const suspect = [];
  for (const r of rows) {
    const b = await client.getBlock({ blockNumber: BigInt(r.block_number) }).catch(() => null);
    if (b && b.hash.toLowerCase() !== r.block_hash.toLowerCase()) {
      suspect.push({ blockNumber: String(r.block_number), indexed: r.block_hash, onChain: b.hash });
    }
  }
  return suspect;
}

/** Register a receiving address to watch. */
export async function watchAddress({ address, label }) {
  const cfg = config();
  return tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO watched_addresses (chain_id, address, label) VALUES ($1,$2,$3)
       ON CONFLICT (chain_id, address) DO UPDATE SET active = true, label = COALESCE($3, watched_addresses.label)
       RETURNING id, address, label, active`,
      [cfg.chainId, address, label ?? null]);
    return rows[0];
  });
}
