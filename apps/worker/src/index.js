import { close, query } from '@retainer/db';
import { config, publicClient } from '@retainer/chain';
import { claimCharge, attemptCharge, claimFloor } from './charger.js';
import { recoverOpenAttempts } from './recovery.js';
import { indexEvents, confirmCharges } from './reconciler.js';
import { indexIncomingTransfers } from './watcher.js';
import { matchPendingTransfers } from './matcher.js';
import { sweepExpectedPayments, settleFromConfirmedCharges } from './sweep.js';
import { deliverAlerts } from './alerts.js';
import { checkGasTank } from './gastank.js';

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const ONCE = process.argv.includes('--once');
const CRASH = process.env.RETAINER_CRASH_AFTER_BROADCAST === '1';
const CRASH_PRE = process.env.RETAINER_CRASH_BEFORE_BROADCAST === '1';
const ONLY = (() => { const i = process.argv.indexOf('--charge'); return i >= 0 ? process.argv[i + 1] : null; })();
const POLL_MS = Number(process.env.RETAINER_POLL_MS ?? 4000);

async function tick() {
  // 1. Resolve anything a previous process left mid-flight, before doing new work.
  const recovered = await recoverOpenAttempts();
  if (recovered.length) log({ event: 'recovery', results: recovered });

  // 2. Index and confirm. The reconciler is the only writer of state='confirmed'.
  const idx = await indexEvents();
  if (idx.indexed) log({ event: 'indexed', ...idx });
  const confirmed = await confirmCharges();
  if (confirmed.length) log({ event: 'confirmed', charges: confirmed });

  // 2b. Watch mode: index incoming transfers, then attribute them. Indexing is
  //     about what the chain says; matching is about what it means, so they are
  //     separate steps and the matcher never auto-matches ambiguously.
  const watched = await indexIncomingTransfers();
  if (watched.indexed) log({ event: 'transfers_indexed', ...watched });
  const matched = await matchPendingTransfers();
  if (matched.length) log({ event: 'matched', results: matched });

  // 2c. Expected payments: settle from confirmed charges, then age the rest.
  //     A terminally failed pull and a watch payment that never arrived both
  //     end up overdue here -- one path, not two.
  const settled = await settleFromConfirmedCharges();
  if (settled.length) log({ event: 'settled_from_charges', expectedPayments: settled });
  const swept = await sweepExpectedPayments();
  if (swept.becameDue.length || swept.becameOverdue.length) log({ event: 'swept', ...swept });

  // 2d. Alerts. Delivery is retried; emission already happened in the same
  //     transaction as the state change that caused it.
  const delivered = await deliverAlerts();
  if (delivered.length) log({ event: 'alerts', results: delivered });

  // 3. Gas tank -- an empty one stops billing silently.
  const tank = await checkGasTank();
  if (tank.level !== 'ok') log({ event: 'gas_tank', ...tank });
  if (tank.level === 'CRITICAL') {
    log({ event: 'halt', reason: 'gas tank critical; refusing to start new charges', ...tank });
    return { charged: 0, halted: true };
  }

  // 4. Do one unit of new work.
  const row = await claimCharge(ONLY);
  if (!row) return { charged: 0 };
  log({ event: 'claimed', chargeId: row.id, permissionHash: row.permission_hash,
        periodStart: row.period_start, amountSource: row.amount_source });
  const out = await attemptCharge(row, { crashAfterBroadcast: CRASH, crashBeforeBroadcast: CRASH_PRE });
  log({ event: 'attempt', chargeId: row.id, ...out });
  return { charged: 1 };
}

async function main() {
  const cfg = config();
  log({ event: 'worker.start', chainId: cfg.chainId, router: cfg.router,
        executor: cfg.executor, once: ONCE, crashInjection: CRASH, crashPre: CRASH_PRE, onlyCharge: ONLY,
        claimAboveChargeId: claimFloor().toString() });
  // Where indexing resumes: the stored cursors, read before the first tick. A missing
  // cursor would mean a fresh start a few thousand blocks back, never from genesis.
  const [ix, wc] = await Promise.all([
    query('SELECT last_indexed_block FROM indexer_state WHERE id = 1'),
    query('SELECT name, last_indexed_block FROM watch_cursors ORDER BY name'),
  ]);
  log({ event: 'worker.cursors', permissionEvents: ix.rows[0]?.last_indexed_block ?? null,
        watch: Object.fromEntries(wc.rows.map((r) => [r.name, r.last_indexed_block])) });
  // Round trips from wherever this runs, logged once at start: the worker is query-heavy,
  // so the distance to the database is worth knowing rather than guessing.
  const ms = async (f, n) => { const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); await f(); t.push(performance.now() - s); }
    t.sort((a, b) => a - b); return { min: +t[0].toFixed(1), median: +t[n >> 1].toFixed(1), max: +t[n - 1].toFixed(1) }; };
  log({ event: 'worker.latency', dbSelect1Ms: await ms(() => query('SELECT 1'), 10),
        rpcBlockNumberMs: await ms(() => publicClient().getBlockNumber({ cacheTime: 0 }), 3) });

  if (ONCE) { await tick(); await close(); return; }

  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log({ event: 'worker.stopping', sig }); stopping = true; });
  }
  while (!stopping) {
    try { await tick(); }
    catch (e) { log({ event: 'tick.error', error: String(e?.stack ?? e) }); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  await close();
}

main().catch(async (e) => { log({ event: 'fatal', error: String(e?.stack ?? e) }); await close(); process.exit(1); });
