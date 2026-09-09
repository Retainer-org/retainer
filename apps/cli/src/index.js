// Minimal operator surface: enough to create a permission, enqueue a charge,
// and inspect what happened. Deliberately not a dashboard.
import { formatUnits } from 'viem';
import { query, close } from '@retainer/db';
import { config, periodFor } from '@retainer/chain';
import { matchPendingTransfers, resolveReview, classifyTransfer } from '../../worker/src/matcher.js';
import { indexIncomingTransfers, watchAddress, detectReorgs } from '../../worker/src/watcher.js';
import { sweepExpectedPayments, settleFromConfirmedCharges } from '../../worker/src/sweep.js';
import { deliverAlerts, addDestination } from '../../worker/src/alerts.js';
import { recentEvents } from '../../worker/src/events.js';
import { checkGasTank } from '../../worker/src/gastank.js';
import { indexEvents, confirmCharges } from '../../worker/src/reconciler.js';

const [cmd, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
const out = (o) => console.log(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

async function main() {
  switch (cmd) {
    case 'enqueue': {
      // Create the charge row for the CURRENT billing period. period_start is
      // derived from the permission, never chosen -- that is what makes the
      // UNIQUE (permission_id, period_start) key a real idempotency guarantee.
      const permId = arg('permission');
      const { rows } = await query('SELECT * FROM permissions WHERE id::text = $1 OR permission_hash = $1', [permId]);
      if (!rows.length) throw new Error('permission not found');
      const p = rows[0];
      const now = Math.floor(Date.now() / 1000);
      const per = periodFor({ start: p.start_ts, end: p.end_ts, period: p.period_seconds }, now);
      if (per.state !== 'ACTIVE') {
        // Still enqueue: the classifier is what should report NOT_STARTED/EXPIRED,
        // so the drill exercises the real path rather than short-circuiting here.
        const anchor = per.state === 'NOT_STARTED' ? BigInt(p.start_ts) : BigInt(p.end_ts) - BigInt(p.period_seconds);
        per.periodStart = anchor; per.periodEnd = anchor + BigInt(p.period_seconds);
      }
      const source = rest.includes('--usage') ? 'usage' : 'fixed';
      const amount = source === 'usage' ? '0' : arg('amount');
      if (source === 'fixed' && !amount) throw new Error('--amount required for a fixed charge');
      const ins = await query(
        `INSERT INTO charges (permission_id, period_start, period_end, amount, amount_source)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (permission_id, period_start) DO NOTHING
         RETURNING id, state`,
        [p.id, per.periodStart.toString(), per.periodEnd.toString(), amount, source]);
      if (!ins.rows.length) {
        const ex = await query('SELECT id, state FROM charges WHERE permission_id=$1 AND period_start=$2',
          [p.id, per.periodStart.toString()]);
        out({ created: false, reason: 'idempotency key already exists for this period', charge: ex.rows[0] });
      } else {
        out({ created: true, charge: ins.rows[0], periodStart: per.periodStart, amountSource: source });
      }
      break;
    }
    case 'record-usage': {
      const permId = arg('permission');
      const { rows } = await query('SELECT * FROM permissions WHERE id::text = $1 OR permission_hash = $1', [permId]);
      const p = rows[0];
      const now = Math.floor(Date.now() / 1000);
      const per = periodFor({ start: p.start_ts, end: p.end_ts, period: p.period_seconds }, now);
      await query(
        `INSERT INTO usage_records (permission_id, period_start, units, unit_price, note)
         VALUES ($1,$2,$3,$4,$5)`,
        [p.id, per.periodStart.toString(), arg('units'), arg('price'), arg('note', 'cli')]);
      out({ recorded: true, units: arg('units'), unitPrice: arg('price'), periodStart: per.periodStart });
      break;
    }
    case 'status': {
      const { rows } = await query(`
        SELECT ch.id, ch.state, ch.amount, ch.amount_source, ch.usage_note, ch.attempts,
               ch.last_failure, ch.failure_detail, ch.period_start, ch.confirmed_tx_hash,
               ch.confirmed_amount, p.permission_hash, p.account, p.recipient
          FROM charges ch JOIN permissions p ON p.id = ch.permission_id
         ORDER BY ch.id DESC LIMIT $1`, [Number(arg('limit', 20))]);
      out(rows);
      break;
    }
    case 'attempts': {
      const { rows } = await query(`
        SELECT id, charge_id, nonce, tx_hash, state, amount, gas_used, block_number,
               revert_selector, failure_mode, signed_at, broadcast_at, resolved_at
          FROM charge_attempts ORDER BY id DESC LIMIT $1`, [Number(arg('limit', 20))]);
      out(rows);
      break;
    }
    case 'ledger': {
      // Every confirmed charge maps to exactly one transaction hash.
      const { rows } = await query(`
        SELECT ch.id AS charge_id, p.permission_hash, p.account, p.recipient,
               ch.period_start, ch.amount, ch.amount_source, ch.confirmed_amount,
               ch.confirmed_tx_hash, ch.confirmed_at,
               (SELECT count(*) FROM onchain_events e WHERE e.tx_hash = ch.confirmed_tx_hash) AS events
          FROM charges ch JOIN permissions p ON p.id = ch.permission_id
         WHERE ch.state = 'confirmed' ORDER BY ch.confirmed_at`);
      out(rows.map(r => ({ ...r, amountUsdc: formatUnits(BigInt(r.confirmed_amount ?? 0), 6) })));
      break;
    }
    case 'audit': {
      const { rows } = await query(
        `SELECT occurred_at, actor, event, permission_id, charge_id, tx_hash, detail
           FROM audit_log ORDER BY id DESC LIMIT $1`, [Number(arg('limit', 50))]);
      out(rows);
      break;
    }
    // ---- phase 2: expected payments, watch mode, review, alerts ----
    case 'customer-add': {
      const r = await query('INSERT INTO customers (label) VALUES ($1) RETURNING id, label', [arg('label', 'unnamed')]);
      out({ created: r.rows[0] }); break;
    }
    case 'customer-link': {
      const r = await query(
        `INSERT INTO customer_addresses (customer_id, chain_id, address, note) VALUES ($1,$2,$3,$4)
         ON CONFLICT (chain_id, address) DO NOTHING RETURNING id, customer_id, address`,
        [arg('customer'), config().chainId, arg('address'), arg('note', 'linked via cli')]);
      out({ linked: r.rows[0] ?? 'already linked to a customer' }); break;
    }
    case 'customers': out((await query(
      `SELECT c.id, c.label, array_remove(array_agg(ca.address), NULL) AS addresses
         FROM customers c LEFT JOIN customer_addresses ca ON ca.customer_id = c.id
        GROUP BY c.id, c.label ORDER BY c.id`)).rows); break;

    case 'expect': {
      // Create an expected payment. Watch fulfilment needs no permission.
      const cfg = config();
      const dueIn = Number(arg('due-in-seconds', '0'));
      const r = await query(
        `INSERT INTO expected_payments
           (customer_id, amount_expected, token, chain_id, due_date, lead_time_seconds, state, fulfilment, permission_id, reference)
         VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5), $6, $7, $8, $9, $10)
         RETURNING id, customer_id, amount_expected, due_date, state::text state, fulfilment::text fulfilment`,
        [arg('customer'), arg('amount'), cfg.usdc, cfg.chainId, dueIn,
         Number(arg('lead-time', '259200')),
         dueIn > 0 ? 'upcoming' : 'due',
         arg('fulfilment', 'watch'), arg('permission') ?? null, arg('reference') ?? null]);
      out({ created: r.rows[0] }); break;
    }
    case 'expected': out((await query(
      `SELECT ep.id, ep.customer_id, ep.amount_expected, ep.amount_settled, ep.state::text state,
              ep.fulfilment::text fulfilment, ep.due_date, ep.reference
         FROM expected_payments ep ORDER BY ep.id DESC LIMIT $1`, [Number(arg('limit', 30))])).rows); break;

    case 'watch-add': out(await watchAddress({ address: arg('address'), label: arg('label') })); break;
    case 'watch-index': out(await indexIncomingTransfers(arg('from') ? { fromBlock: Number(arg('from')) } : {})); break;
    case 'match': out(await matchPendingTransfers()); break;
    case 'reorgs': out(await detectReorgs()); break;

    case 'transfers': out((await query(
      `SELECT id, tx_hash, from_address, value, match_state::text match_state, match_reason::text match_reason,
              jsonb_array_length(candidates) AS candidate_count, block_number
         FROM incoming_transfers ORDER BY block_number DESC, log_index DESC LIMIT $1`, [Number(arg('limit', 30))])).rows); break;

    case 'review': out((await query(
      `SELECT id, tx_hash, from_address, value, match_reason::text reason, candidates
         FROM incoming_transfers WHERE match_state = 'needs_review' ORDER BY block_number, log_index`)).rows); break;

    case 'resolve': out(await resolveReview({
      transferId: arg('transfer'), action: arg('action', 'apply'),
      expectedPaymentId: arg('expected'), amount: arg('amount'),
      linkSender: arg('link-sender'), by: arg('by', 'review:cli') })); break;

    case 'sweep': out({ settled: await settleFromConfirmedCharges(), ...(await sweepExpectedPayments()) }); break;

    case 'dest-add': out(await addDestination({
      channel: arg('channel', 'webhook'), target: arg('target'),
      secret: arg('secret') ?? null,
      eventTypes: arg('events') ? arg('events').split(',') : null })); break;
    case 'deliver': out(await deliverAlerts()); break;
    case 'events': out(await recentEvents(Number(arg('limit', 30)))); break;
    case 'deliveries': out((await query(
      `SELECT d.id, e.type, d.channel::text channel, d.target, d.state::text state, d.attempts,
              d.last_status, d.transport, d.last_error, d.next_attempt_at
         FROM deliveries d JOIN events e ON e.id = d.event_id
        ORDER BY d.id DESC LIMIT $1`, [Number(arg('limit', 30))])).rows); break;

    case 'gas': out(await checkGasTank()); break;
    case 'reconcile': {
      const idx = await indexEvents(arg('from') ? { fromBlock: Number(arg('from')) } : {});
      const conf = await confirmCharges();
      out({ indexed: idx, confirmed: conf });
      break;
    }
    default:
      console.log(`retainer cli
  enqueue      --permission <id|hash> [--amount <base units> | --usage]
  record-usage --permission <id|hash> --units <n> --price <base units>
  status       [--limit n]      charges
  attempts     [--limit n]      broadcast attempts
  ledger                        confirmed charges -> tx hashes
  audit        [--limit n]      consent + charge audit trail
  gas                           executor gas tank
  --- phase 2 ---
  customer-add  --label L                     customers
  customer-link --customer N --address 0x..   link a sender to a customer
  expect        --customer N --amount U [--fulfilment watch|pull] [--due-in-seconds S]
  expected      [--limit n]                   expected payments
  watch-add     --address 0x.. [--label L]    register a receiving address
  watch-index   [--from block]                index incoming transfers
  match                                       classify pending transfers
  transfers | review                          indexed transfers / review queue
  resolve       --transfer N --action apply|ignore [--expected M] [--amount U] [--link-sender C]
  sweep                                       settle from charges, then age to due/overdue
  dest-add      --channel webhook|email --target T [--secret S] [--events a,b]
  deliver | deliveries | events               alert delivery
  reconcile    [--from block]   index events and confirm`);
  }
  await close();
}
main().catch(async (e) => { console.error(String(e?.stack ?? e)); await close(); process.exit(1); });
