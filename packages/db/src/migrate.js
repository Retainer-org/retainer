import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, close } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

const applied = new Set((await query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

let ran = 0;
for (const f of files) {
  if (applied.has(f)) { console.log(`  skip  ${f}`); continue; }
  const sql = readFileSync(join(migrationsDir, f), 'utf8');
  await query(sql);
  await query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
  console.log(`  apply ${f}`);
  ran++;
}
console.log(ran ? `${ran} migration(s) applied` : 'up to date');
await close();
