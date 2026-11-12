import type { DB } from '../db/index.js';
import { buyerAccept, sellerOffer, type Behaviour, type Draft } from '../runtime/testAgent.js';

/**
 * How the scenario engine talks to an agent. An agent's job is to produce signed requests; ProxyProof's job is to
 * verify them. The engine never decides an outcome: it asks the agent to act, the agent calls ProxyProof's public
 * agent API, and the engine records what ProxyProof answered.
 *
 * Two kinds of driver:
 *  - TestRuntimeDriver: a labelled test agent whose key ProxyProof holds. It can be told to misbehave (an attack
 *    technique applied to a genuine request), which is how the scenarios reproduce real-world failures.
 *  - ExternalAgentDriver: a real agent behind its own API. The contract is fixed here; the connection is configured
 *    later, and until then it refuses rather than pretending.
 */
export type Api = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>;
export type DriverEnv = { db: DB; api: Api; workspaceId: string; publicUrl: string };

export type OfferTask = { agentId: string; buyerOrgId: string; draft: Draft; behaviour: Behaviour; transactionId?: string };
export type AcceptTask = { agentId: string; transactionId: string; behaviour: Behaviour };
/** What ProxyProof answered to the agent's request, as the agent received it. */
export type AgentReply = { http_status?: number; transaction_id?: string; decision?: string; permit?: { jws: string } | null; error?: string; [k: string]: unknown };

export interface AgentDriver {
  readonly kind: 'TEST_RUNTIME' | 'EXTERNAL';
  offer(env: DriverEnv, task: OfferTask): Promise<AgentReply>;
  accept(env: DriverEnv, task: AcceptTask): Promise<AgentReply>;
}

export const TestRuntimeDriver: AgentDriver = {
  kind: 'TEST_RUNTIME',
  offer: (env, t) => sellerOffer(env.db, env.api, { workspaceId: env.workspaceId, publicUrl: env.publicUrl, agentId: t.agentId, buyerOrgId: t.buyerOrgId, draft: t.draft, behaviour: t.behaviour, transactionId: t.transactionId }),
  accept: (env, t) => buyerAccept(env.db, env.api, { workspaceId: env.workspaceId, publicUrl: env.publicUrl, agentId: t.agentId, transactionId: t.transactionId, behaviour: t.behaviour }),
};

/**
 * A real agent reached over its own HTTP API. Expected contract, for when the agent APIs are connected:
 *   POST {url}/proxyproof/offer   { workspace, audience, buyer_did, draft }      → the agent signs and submits the offer itself
 *   POST {url}/proxyproof/accept  { workspace, audience, transaction_id }        → the agent reads the terms and signs acceptance
 * Each returns ProxyProof's response as the agent received it. Behaviours do not apply: a real agent behaves as it does.
 */
export function ExternalAgentDriver(conn: { url?: string; token?: string }): AgentDriver {
  const call = async (path: string, body: unknown): Promise<AgentReply> => {
    if (!conn.url) throw new Error('This agent’s API is not connected yet. Add its URL to use it in scenarios.');
    const res = await fetch(`${conn.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    return { http_status: res.status, ...(await res.json().catch(() => ({ error: 'The agent returned no JSON.' }))) };
  };
  return {
    kind: 'EXTERNAL',
    offer: (env, t) => call('/proxyproof/offer', { workspace: env.workspaceId, draft: t.draft, buyer_org_id: t.buyerOrgId, transaction_id: t.transactionId }),
    accept: (env, t) => call('/proxyproof/accept', { workspace: env.workspaceId, transaction_id: t.transactionId }),
  };
}
