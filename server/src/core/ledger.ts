import { all, one, run, type DB } from '../db/index.js';
import { canonicalize, newId, nowIso, sha256 } from './util.js';

export const GENESIS = '0'.repeat(64);
export type Actor = { type: 'USER' | 'AGENT' | 'SYSTEM' | 'PROVIDER'; id?: string | null };

function eventHash(e: { workspace_id: string; seq: number; event_type: string; actor_type: string; actor_id: string | null; payment_request_id: string | null; payload: string; prev_hash: string; created_at: string }) {
  return sha256(canonicalize({ w: e.workspace_id, s: e.seq, t: e.event_type, at: e.actor_type, ai: e.actor_id, r: e.payment_request_id, p: e.payload, h: e.prev_hash, c: e.created_at }));
}

/** Appends one event. Node's SQLite calls are synchronous, so seq assignment cannot interleave in this process. */
export function appendAudit(db: DB, workspaceId: string, eventType: string, actor: Actor, requestId: string | null, payload: unknown = {}) {
  const last = one<{ seq: number; hash: string }>(db, 'SELECT seq, hash FROM audit_events WHERE workspace_id = ? ORDER BY seq DESC LIMIT 1', workspaceId);
  const e = {
    workspace_id: workspaceId, seq: (last?.seq ?? 0) + 1, event_type: eventType, actor_type: actor.type, actor_id: actor.id ?? null,
    payment_request_id: requestId, payload: canonicalize(payload), prev_hash: last?.hash ?? GENESIS, created_at: nowIso(),
  };
  const hash = eventHash(e);
  run(db, `INSERT INTO audit_events (id, workspace_id, seq, event_type, actor_type, actor_id, payment_request_id, payload, prev_hash, hash, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, newId('aud'), e.workspace_id, e.seq, e.event_type, e.actor_type, e.actor_id, e.payment_request_id, e.payload, e.prev_hash, hash, e.created_at);
  return hash;
}

export function verifyChain(db: DB, workspaceId: string): { ok: boolean; events: number; brokenAtSeq?: number; head?: string } {
  const rows = all<any>(db, 'SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY seq', workspaceId);
  let prev = GENESIS, expectedSeq = 1;
  for (const r of rows) {
    if (r.seq !== expectedSeq || r.prev_hash !== prev || eventHash(r) !== r.hash) return { ok: false, events: rows.length, brokenAtSeq: r.seq };
    prev = r.hash; expectedSeq++;
  }
  return { ok: true, events: rows.length, head: prev };
}
