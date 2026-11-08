import { generateKeyPairSync, sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify, importPKCS8, importSPKI, errors as joseErrors } from 'jose';
import { all, one, run, serverSecret, type DB } from '../db/index.js';
import { canonicalize, newId, nowIso, sha256 } from '../core/util.js';
import { appendAudit } from '../core/ledger.js';

export function newAgentKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/** Server keypair that signs grants. Stored in the database when not configured; never reaches a model or client. */
function grantKeys(db: DB) {
  let pem = one<{ value: string }>(db, `SELECT value FROM server_secrets WHERE name = 'grant_private_key'`)?.value;
  if (!pem) { pem = newAgentKeys().privateKeyPem; run(db, `INSERT INTO server_secrets (name, value) VALUES ('grant_private_key', ?)`, pem); }
  const publicPem = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'pem' }).toString();
  return { privatePem: pem, publicPem };
}

export type GrantInput = {
  workspaceId: string; agentId: string; principalUserId: string; createdBy: string;
  actions?: string[]; categories: string[]; vendorIds: string[]; currencies: string[];
  perTxMaxMinor: number; dailyBudgetMinor: number; monthlyBudgetMinor: number; expiresAt: string; policyVersion: number;
};
/**
 * Issues a PayeeProof scoped authorization: an EdDSA JWS bound to principal, agent, scope, limits, expiry and
 * policy version. This is an internal format. It is not an AP2 mandate and PayPal does not issue it.
 */
export async function issueGrant(db: DB, g: GrantInput) {
  const version = (one<{ v: number }>(db, 'SELECT MAX(version) v FROM agent_authorizations WHERE agent_id = ?', g.agentId)?.v ?? 0) + 1;
  const id = newId('auth');
  const actions = g.actions ?? ['PAYMENT_REQUEST'];
  const { privatePem } = grantKeys(db);
  const token = await new SignJWT({ ver: version, principal: g.principalUserId, actions, categories: g.categories, vendors: g.vendorIds, currencies: g.currencies, per_tx_max_minor: g.perTxMaxMinor, policy_version: g.policyVersion, format: 'payeeproof-scoped-authorization/1' })
    .setProtectedHeader({ alg: 'EdDSA' }).setIssuer('payeeproof').setSubject(g.agentId).setAudience(g.workspaceId).setJti(id)
    .setIssuedAt().setExpirationTime(Math.floor(Date.parse(g.expiresAt) / 1000)).sign(await importPKCS8(privatePem, 'EdDSA'));
  run(db, `UPDATE agent_authorizations SET status = 'SUPERSEDED' WHERE agent_id = ? AND status = 'ACTIVE'`, g.agentId);
  run(db, `INSERT INTO agent_authorizations (id, workspace_id, agent_id, version, principal_user_id, actions, categories, vendor_ids, currencies, per_tx_max_minor, daily_budget_minor, monthly_budget_minor, policy_version, expires_at, status, token, created_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?)`, id, g.workspaceId, g.agentId, version, g.principalUserId, JSON.stringify(actions), JSON.stringify(g.categories), JSON.stringify(g.vendorIds), JSON.stringify(g.currencies), g.perTxMaxMinor, g.dailyBudgetMinor, g.monthlyBudgetMinor, g.policyVersion, g.expiresAt, token, g.createdBy, nowIso());
  appendAudit(db, g.workspaceId, 'AUTHORIZATION_ISSUED', { type: 'USER', id: g.createdBy }, null, { authorization_id: id, agent_id: g.agentId, version, per_tx_max_minor: g.perTxMaxMinor, expires_at: g.expiresAt, policy_version: g.policyVersion });
  return { id, version, token };
}

export type AgentPayment = {
  vendor_id?: string; payee_name?: string; destination_type?: string; destination_value?: string;
  amount_minor: number; currency: string; category: string; purpose?: string; invoice_reference?: string; artifact_sha256?: string;
};
export type AgentEnvelope = { agent_id: string; authorization: string; nonce: string; timestamp: string; payment: AgentPayment; signature?: string };

export const signingPayload = (e: AgentEnvelope) => { const { signature: _, ...rest } = e; return canonicalize(rest); };
export function signEnvelope(e: Omit<AgentEnvelope, 'signature'>, privateKeyPem: string): AgentEnvelope {
  const signature = edSign(null, Buffer.from(signingPayload(e as AgentEnvelope)), privateKeyPem).toString('base64url');
  return { ...e, signature };
}
export const newNonce = () => randomBytes(16).toString('base64url');

export type AgentCheck = {
  registered: boolean; signature: 'VALID' | 'INVALID' | 'MISSING' | 'STALE';
  grantFormat: 'VALID' | 'MISSING' | 'FORGED' | 'EXPIRED' | 'WRONG_AGENT' | 'WRONG_WORKSPACE';
  replayedNonce: boolean; authorizationId: string | null; authorizationVersion: number | null;
};
const CLOCK_SKEW_MS = 5 * 60_000;

/** Verifies origin at submission time. The outcome is stored and every later evaluation also reads live revocation state. */
export async function verifyEnvelope(db: DB, workspaceId: string, e: AgentEnvelope): Promise<AgentCheck> {
  const agent = one<any>(db, 'SELECT * FROM agents WHERE id = ? AND workspace_id = ?', e.agent_id, workspaceId);
  const out: AgentCheck = { registered: Boolean(agent), signature: 'MISSING', grantFormat: 'MISSING', replayedNonce: false, authorizationId: null, authorizationVersion: null };
  if (agent && e.signature) {
    let ok = false;
    try { ok = edVerify(null, Buffer.from(signingPayload(e)), agent.public_key_pem, Buffer.from(e.signature, 'base64url')); } catch { ok = false; }
    out.signature = !ok ? 'INVALID' : Math.abs(Date.now() - Date.parse(e.timestamp)) > CLOCK_SKEW_MS || Number.isNaN(Date.parse(e.timestamp)) ? 'STALE' : 'VALID';
  }
  if (agent && out.signature === 'VALID') {
    const res = run(db, 'INSERT OR IGNORE INTO agent_nonces (agent_id, nonce, seen_at) VALUES (?,?,?)', agent.id, String(e.nonce), nowIso());
    if (Number(res.changes) === 0) out.replayedNonce = true;
    run(db, 'UPDATE agents SET last_seen_at = ? WHERE id = ?', nowIso(), agent.id);
  }
  if (e.authorization) {
    try {
      const key = await importSPKI(grantKeys(db).publicPem, 'EdDSA');
      const { payload } = await jwtVerify(e.authorization, key, { issuer: 'payeeproof', algorithms: ['EdDSA'] });
      out.authorizationId = payload.jti ?? null;
      out.authorizationVersion = (payload.ver as number) ?? null;
      out.grantFormat = payload.aud !== workspaceId ? 'WRONG_WORKSPACE' : payload.sub !== e.agent_id ? 'WRONG_AGENT' : 'VALID';
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) { out.grantFormat = 'EXPIRED'; out.authorizationId = (err.payload?.jti as string) ?? null; }
      else out.grantFormat = 'FORGED';
    }
  }
  return out;
}

export function agentSpend(db: DB, agentId: string, currency: string, excludeRequestId: string) {
  const sum = (since: string) => one<{ s: number }>(db, `SELECT COALESCE(SUM(amount_minor),0) s FROM payment_attempts WHERE agent_id = ? AND currency = ? AND status <> 'FAILED' AND created_at >= ? AND (payment_request_id IS NULL OR payment_request_id <> ?)`, agentId, currency, since, excludeRequestId)!.s;
  const now = new Date();
  return { day: sum(now.toISOString().slice(0, 10)), month: sum(now.toISOString().slice(0, 7)) };
}
export const listAgents = (db: DB, ws: string) => all<any>(db, 'SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at', ws);
export const hashBytes = sha256;
