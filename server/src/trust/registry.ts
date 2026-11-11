import { z } from 'zod';
import { all, one, run, type DB } from '../db/index.js';
import { randomBytes } from 'node:crypto';
import { newId, nowIso, sha256 } from '../core/util.js';
import { appendAudit, type Actor } from '../core/ledger.js';
import { didKey, newKeyPair, parsePublicJwk, thumbprint, type PublicJwk } from './keys.js';
import { ACTIONS, issueDelegationCredential, type Mandate } from './credentials.js';

export class Forbidden extends Error {}
export class Conflict extends Error {}
export class NotFound extends Error {}
export class StatusUnavailable extends Error {}

const J = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function createPrincipal(db: DB, ws: string, p: { name: string; role: 'BUYER' | 'SELLER'; verified: boolean; method?: string; paymentAccount?: string | null }) {
  const keys = newKeyPair();
  const id = newId('prn');
  const did = didKey(keys.publicJwk);
  run(db, `INSERT INTO principals (id, workspace_id, name, role, did, public_jwk, status, verification_method, payment_account, key_created_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, ws, p.name, p.role, did, JSON.stringify(keys.publicJwk), p.verified ? 'VERIFIED' : 'UNVERIFIED', p.method ?? null, p.paymentAccount ?? null, nowIso(), nowIso());
  run(db, 'INSERT INTO principal_keys (principal_id, private_pem) VALUES (?,?)', id, keys.privatePem);
  appendAudit(db, ws, 'PRINCIPAL_CREATED', { type: 'SYSTEM' }, id, { name: p.name, role: p.role, did, status: p.verified ? 'VERIFIED' : 'UNVERIFIED' });
  return id;
}

export type Connection = 'TEST_RUNTIME' | 'API' | 'MCP';
/** What each connection type actually proves. Shown to users; never upgraded by a platform's name. */
export const ASSURANCE: Record<Connection, string> = {
  API: 'Agent-held key: the agent signs every request with its own Ed25519 key',
  MCP: 'Connection token: a ProxyProof-issued bearer token, with a ProxyProof-held signing key for this connection',
  TEST_RUNTIME: 'Labelled test agent: key held by the ProxyProof test runtime',
};

/**
 * Registers an agent created elsewhere (Claude, ChatGPT, Grok, Gemini, any framework) against the organization it claims to
 * act for. This proves only control of a key or a connection token. The agent can do nothing until that organization
 * approves a delegation: the default state is CONNECTED, NOT AUTHORIZED.
 */
export async function registerAgent(db: DB, ws: string, p: { name: string; side: 'BUYER' | 'SELLER'; principalId: string; publicJwk?: unknown; provider?: string; connection?: Connection }, actor: Actor) {
  const principal = one<any>(db, 'SELECT * FROM principals WHERE id = ? AND workspace_id = ?', p.principalId, ws);
  if (!principal) throw new NotFound('That organization does not exist.');
  if (principal.role !== p.side) throw new Conflict(`A ${p.side.toLowerCase()} agent must act for a ${p.side.toLowerCase()} organization. ${principal.name} is a ${principal.role.toLowerCase()}.`);
  const connection: Connection = p.connection ?? (p.publicJwk ? 'API' : 'TEST_RUNTIME');
  if (connection === 'API' && !p.publicJwk) throw new Conflict('An API agent must register its own public key.');
  let jwk: PublicJwk, privatePem: string | null = null;
  if (p.publicJwk) jwk = parsePublicJwk(p.publicJwk);
  else { const k = newKeyPair(); jwk = k.publicJwk; privatePem = k.privatePem; }
  const did = didKey(jwk);
  if (one(db, 'SELECT 1 FROM agents WHERE workspace_id = ? AND did = ?', ws, did)) throw new Conflict('An agent with this key is already registered.');
  const id = newId('agt');
  // MCP connections get a bearer token shown once. Only its hash is stored.
  const token = connection === 'MCP' ? `ppc_${randomBytes(24).toString('base64url')}` : null;
  run(db, `INSERT INTO agents (id, workspace_id, name, side, principal_id, did, public_jwk, thumbprint, provider, connection, assurance, connection_token_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, ws, p.name.slice(0, 80), p.side, p.principalId, did, JSON.stringify(jwk), await thumbprint(jwk), (p.provider ?? 'Custom').slice(0, 40), connection, ASSURANCE[connection], token ? sha256(token) : null, nowIso());
  if (privatePem) run(db, 'INSERT INTO runtime_agent_keys (agent_id, private_pem) VALUES (?,?)', id, privatePem);
  appendAudit(db, ws, 'AGENT_CONNECTED', actor, id, { name: p.name, side: p.side, principal_id: p.principalId, did, provider: p.provider ?? 'Custom', connection });
  return { id, did, token };
}

export const MandateInput = z.object({
  actions: z.array(z.enum(ACTIONS)).min(1),
  max_amount_minor: z.number().int().positive().max(100_000_000),
  currencies: z.array(z.string().length(3)).min(1),
  categories: z.array(z.string().min(1).max(40)).min(1),
  counterparties: z.array(z.string().startsWith('did:key:')).default([]),
  destinations: z.array(z.string().max(200)).optional(),
  step_up_above_minor: z.number().int().positive().nullable().optional(),
  may_delegate: z.boolean().optional(),
});
const SIDE_ACTIONS: Record<string, string[]> = { BUYER: ['purchase', 'research', 'delegate'], SELLER: ['quote', 'issue_invoice', 'request_payment', 'delegate'] };

/** Asks the principal to sign a delegation. Nothing is signed until a human approves on the principal's behalf. */
export function requestDelegation(db: DB, ws: string, agentId: string, input: { mandate: unknown; validUntil: string; validFrom?: string }, actor: Actor) {
  const agent = one<any>(db, 'SELECT * FROM agents WHERE id = ? AND workspace_id = ?', agentId, ws);
  if (!agent) throw new NotFound('That agent does not exist.');
  const mandate = MandateInput.parse(input.mandate) as Mandate;
  mandate.currencies = mandate.currencies.map((c) => c.toUpperCase());
  const wrong = mandate.actions.filter((a) => !SIDE_ACTIONS[agent.side].includes(a));
  if (wrong.length) throw new Conflict(`A ${agent.side.toLowerCase()} agent cannot be given: ${wrong.join(', ')}.`);
  const validFrom = input.validFrom ?? nowIso();
  if (!(Date.parse(input.validUntil) > Date.parse(validFrom))) throw new Conflict('The delegation must end after it starts.');
  run(db, `UPDATE delegations SET status = 'DECLINED' WHERE agent_id = ? AND status = 'PENDING'`, agentId);
  const id = newId('dlg');
  run(db, `INSERT INTO delegations (id, workspace_id, agent_id, principal_id, mandate, valid_from, valid_until, status, requested_by, requested_at) VALUES (?,?,?,?,?,?,?, 'PENDING', ?, ?)`,
    id, ws, agentId, agent.principal_id, JSON.stringify(mandate), validFrom, new Date(input.validUntil).toISOString(), `${actor.type}:${actor.id ?? ''}`, nowIso());
  appendAudit(db, ws, 'DELEGATION_REQUESTED', actor, id, { agent_id: agentId, mandate, valid_until: input.validUntil });
  return id;
}

/**
 * The delegation boundary. Only an authenticated human, acting for the principal, triggers the principal's key to sign.
 * Agents call no route that reaches this function.
 */
export async function approveDelegation(db: DB, ws: string, delegationId: string, user: { id: string; name: string }, publicUrl: string) {
  const d = one<any>(db, 'SELECT * FROM delegations WHERE id = ? AND workspace_id = ?', delegationId, ws);
  if (!d) throw new NotFound('That delegation does not exist.');
  if (d.status !== 'PENDING') throw new Conflict(`This delegation is ${d.status.toLowerCase()}, not waiting for approval.`);
  const agent = one<any>(db, 'SELECT * FROM agents WHERE id = ?', d.agent_id);
  const principal = one<any>(db, 'SELECT * FROM principals WHERE id = ?', d.principal_id);
  const key = one<any>(db, 'SELECT private_pem FROM principal_keys WHERE principal_id = ?', principal.id);
  const credential = await issueDelegationCredential({
    id: d.id, principalDid: principal.did, principalName: principal.name, principalPem: key.private_pem,
    agentDid: agent.did, agentJwk: J(agent.public_jwk, null)!, role: agent.side === 'BUYER' ? 'BUYER_AGENT' : 'SELLER_AGENT',
    mandate: J(d.mandate, null)!, validFrom: d.valid_from, validUntil: d.valid_until, statusUrl: `${publicUrl}/api/v1/status/${d.id}`,
  });
  run(db, `UPDATE delegations SET status = 'SUPERSEDED' WHERE agent_id = ? AND status = 'ACTIVE'`, agent.id);
  run(db, `UPDATE delegations SET status = 'ACTIVE', credential = ?, credential_hash = ?, approved_by = ?, approved_at = ? WHERE id = ?`, credential, sha256(credential), user.id, nowIso(), d.id);
  appendAudit(db, ws, 'DELEGATION_APPROVED', { type: 'USER', id: user.id }, d.id, { agent_id: agent.id, principal_id: principal.id, credential_sha256: sha256(credential), approved_for: principal.name, approved_by: user.name });
  return credential;
}

export function declineDelegation(db: DB, ws: string, delegationId: string, userId: string) {
  const d = one<any>(db, 'SELECT * FROM delegations WHERE id = ? AND workspace_id = ?', delegationId, ws);
  if (!d || d.status !== 'PENDING') throw new Conflict('Only a pending delegation can be declined.');
  run(db, `UPDATE delegations SET status = 'DECLINED' WHERE id = ?`, d.id);
  appendAudit(db, ws, 'DELEGATION_DECLINED', { type: 'USER', id: userId }, d.id, { agent_id: d.agent_id });
}

/** Revocation takes effect on the next check. Children issued under this authority are revoked with it. */
export function revokeDelegation(db: DB, ws: string, delegationId: string, userId: string, reason?: string) {
  const d = one<any>(db, 'SELECT * FROM delegations WHERE id = ? AND workspace_id = ?', delegationId, ws);
  if (!d || d.status !== 'ACTIVE') throw new Conflict('Only an active delegation can be revoked.');
  const now = nowIso();
  run(db, `UPDATE delegations SET status = 'REVOKED', revoked_by = ?, revoked_at = ?, revoked_reason = ? WHERE id = ?`, userId, now, reason ?? null, d.id);
  appendAudit(db, ws, 'DELEGATION_REVOKED', { type: 'USER', id: userId }, d.id, { agent_id: d.agent_id, reason: reason ?? null });
  for (const child of all<any>(db, `SELECT id FROM delegations WHERE parent_id = ? AND status = 'ACTIVE'`, d.id)) {
    revokeDelegation(db, ws, child.id, userId, 'Revoked because the parent delegation was revoked');
  }
}

/** The revocation status service. When it is unavailable the caller must fail closed, never assume "still valid". */
export function delegationStatus(db: DB, ws: string, delegationId: string): 'ACTIVE' | 'REVOKED' | 'SUPERSEDED' | 'UNKNOWN' {
  const w = one<any>(db, 'SELECT status_service FROM workspaces WHERE id = ?', ws);
  if (!w || w.status_service === 'DOWN') throw new StatusUnavailable('The delegation status service did not respond.');
  const d = one<any>(db, 'SELECT status FROM delegations WHERE id = ? AND workspace_id = ?', delegationId, ws);
  if (!d) return 'UNKNOWN';
  return d.status === 'ACTIVE' ? 'ACTIVE' : d.status === 'REVOKED' ? 'REVOKED' : d.status === 'SUPERSEDED' ? 'SUPERSEDED' : 'UNKNOWN';
}

export type AgentState = 'CONNECTED' | 'PENDING_APPROVAL' | 'AUTHORIZED' | 'EXPIRED' | 'REVOKED';
export function agentState(db: DB, agentId: string): { state: AgentState; active: any; pending: any; latest: any } {
  const active = one<any>(db, `SELECT * FROM delegations WHERE agent_id = ? AND status = 'ACTIVE' ORDER BY approved_at DESC LIMIT 1`, agentId);
  const pending = one<any>(db, `SELECT * FROM delegations WHERE agent_id = ? AND status = 'PENDING' ORDER BY requested_at DESC LIMIT 1`, agentId);
  const latest = one<any>(db, `SELECT * FROM delegations WHERE agent_id = ? AND status IN ('ACTIVE','REVOKED','SUPERSEDED') ORDER BY COALESCE(revoked_at, approved_at) DESC LIMIT 1`, agentId);
  if (active) return { state: Date.parse(active.valid_until) <= Date.now() ? 'EXPIRED' : 'AUTHORIZED', active, pending, latest };
  if (pending) return { state: 'PENDING_APPROVAL', active: null, pending, latest };
  if (latest?.status === 'REVOKED') return { state: 'REVOKED', active: null, pending, latest };
  return { state: 'CONNECTED', active: null, pending, latest };
}

export const principalsOf = (db: DB, ws: string) => all<any>(db, 'SELECT * FROM principals WHERE workspace_id = ? ORDER BY role, created_at', ws);
export const parseJson = J;
