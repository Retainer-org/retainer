import { close } from '@retainer/db';
import { config } from '@retainer/chain';
import { claimCharge, attemptCharge } from './charger.js';
import { recoverOpenAttempts } from './recovery.js';
import { indexEvents, confirmCharges } from './reconciler.js';
import { checkGasTank } from './gastank.js';

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

const ONCE = process.argv.includes('--once');
const CRASH = process.env.RETAINER_CRASH_AFTER_BROADCAST === '1';
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

  // 3. Gas tank -- an empty one stops billing silently.
  const tank = await checkGasTank();
  if (tank.level !== 'ok') log({ event: 'gas_tank', ...tank });
  if (tank.level === 'CRITICAL') {
    log({ event: 'halt', reason: 'gas tank critical; refusing to start new charges', ...tank });
    return { charged: 0, halted: true };
  }

  // 4. Do one unit of new work.
  const row = await claimCharge();
  if (!row) return { charged: 0 };
  log({ event: 'claimed', chargeId: row.id, permissionHash: row.permission_hash,
        periodStart: row.period_start, amountSource: row.amount_source });
  const out = await attemptCharge(row, { crashAfterBroadcast: CRASH });
  log({ event: 'attempt', chargeId: row.id, ...out });
  return { charged: 1 };
}

async function main() {
  const cfg = config();
  log({ event: 'worker.start', chainId: cfg.chainId, router: cfg.router,
        executor: cfg.executor, once: ONCE, crashInjection: CRASH });

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
