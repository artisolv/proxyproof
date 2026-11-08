import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export type DB = DatabaseSync;
const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/** Runs fn inside an immediate transaction. Synchronous on purpose: no await can interleave a claim. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const all = <T = any>(db: DB, sql: string, ...p: any[]): T[] => db.prepare(sql).all(...p) as T[];
export const one = <T = any>(db: DB, sql: string, ...p: any[]): T | undefined => db.prepare(sql).get(...p) as T | undefined;
export const run = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).run(...p);

export function serverSecret(db: DB, name: string, configured?: string): string {
  if (configured) return `${name}:${configured}`;
  const row = one<{ value: string }>(db, 'SELECT value FROM server_secrets WHERE name = ?', name);
  if (row) return row.value;
  const value = randomBytes(32).toString('base64url');
  run(db, 'INSERT INTO server_secrets (name, value) VALUES (?, ?)', name, value);
  return value;
}

/** Additive migrations for databases created by earlier versions. Each step is idempotent. */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'approvals', column: 'reviewed_codes', ddl: "ALTER TABLE approvals ADD COLUMN reviewed_codes TEXT NOT NULL DEFAULT '[]'" },
  { table: 'payment_attempts', column: 'invoice_id', ddl: 'ALTER TABLE payment_attempts ADD COLUMN invoice_id TEXT' },
  { table: 'payment_attempts', column: 'agent_id', ddl: 'ALTER TABLE payment_attempts ADD COLUMN agent_id TEXT' },
];
function migrate(db: DB) {
  for (const m of MIGRATIONS) {
    const cols = (db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(m.column)) db.exec(m.ddl);
  }
}
