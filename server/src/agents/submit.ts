import { one, run, type DB } from '../db/index.js';
import { nowIso, sha256 } from '../core/util.js';
import { analyze, createRequest, type Ctx, type Upload } from '../pipeline.js';
import { verifyEnvelope, type AgentEnvelope } from './authority.js';
import { appendAudit } from '../core/ledger.js';

/** The one path for agent requests, real or simulated. The agent gets a structured answer and no secrets. */
export async function submitAgentRequest(ctx: Ctx, workspaceId: string, envelope: AgentEnvelope, files: Upload[] = [], opts: { label?: string } = {}) {
  const { db } = ctx;
  const check = await verifyEnvelope(db, workspaceId, envelope);
  // The signature covers a hash over every attached file, so adding or swapping documents breaks the binding.
  if ((files.length || envelope.payment.artifact_sha256) && envelope.payment.artifact_sha256 !== filesDigest(files)) check.signature = 'INVALID';
  // Requests whose origin cannot be proven are recorded and denied, but their files are never ingested,
  // so an anonymous caller cannot plant invoices that affect duplicate checks or history.
  const trusted = check.registered && check.signature === 'VALID' && !check.replayedNonce;
  const agent = one<any>(db, 'SELECT * FROM agents WHERE id = ? AND workspace_id = ?', envelope.agent_id, workspaceId);
  const actor = { type: 'AGENT' as const, id: String(envelope.agent_id).slice(0, 100) };
  const id = createRequest(db, {
    workspaceId, origin: 'AGENT', agentId: agent?.id ?? null, claimedAgentId: String(envelope.agent_id).slice(0, 100), principalId: agent?.principal_user_id ?? null,
    agentCheck: check, payment: envelope.payment, vendorId: agent ? envelope.payment.vendor_id : null, label: opts.label,
  }, actor);
  const result = await analyze(ctx, id, trusted ? files : [], actor);
  return { request_id: id, decision: result.decision, reasons: result.reasons.map((r) => ({ code: r.code, message: r.message })), executable_by_agent: false, transaction_fingerprint: result.fingerprint };
}
export const filesDigest = (files: Upload[]) => files.length ? sha256(files.map((f) => sha256(f.bytes)).join(',')) : undefined;
export const recordAgentSeen = (db: DB, id: string) => run(db, 'UPDATE agents SET last_seen_at = ? WHERE id = ?', nowIso(), id);
export { appendAudit };
