import pg from 'pg';

// NUMERIC comes back as a string by default; we want BigInt-safe strings, so
// leave it as-is and convert at the edges. BIGINT (int8) likewise.
pg.types.setTypeParser(20, (v) => v);     // int8
pg.types.setTypeParser(1700, (v) => v);   // numeric

let _pool;
export function pool() {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    _pool = new pg.Pool({
      connectionString,
      ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: true },
      max: 5,
    });
  }
  return _pool;
}

export async function query(text, params) {
  return pool().query(text, params);
}

/** Run fn inside a transaction. Rolls back on throw. */
export async function tx(fn) {
  const c = await pool().connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    c.release();
  }
}

export async function audit(c, { actor, event, permissionId = null, chargeId = null, txHash = null, detail = {} }) {
  await c.query(
    `INSERT INTO audit_log (actor, event, permission_id, charge_id, tx_hash, detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor, event, permissionId, chargeId, txHash, JSON.stringify(detail)],
  );
}

export async function close() { if (_pool) { await _pool.end(); _pool = undefined; } }
