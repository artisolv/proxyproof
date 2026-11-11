import { SignJWT } from 'jose';
import { one, type DB } from '../db/index.js';
import { canonicalize, sha256 } from '../core/util.js';
import { didKey, newKeyPair, signingKey } from '../trust/keys.js';
import { requestAudience, signAgentRequest } from '../trust/credentials.js';
import { parseJson as J } from '../trust/registry.js';

/**
 * Labelled test agents, so judges can drive both sides of a transaction from the dashboard. Each holds its own key and
 * talks to ProxyProof only through the public agent API (the same handlers an external agent reaches). It cannot write
 * transaction state and never decides an outcome.
 *
 * Behaviours are attack techniques applied to genuine requests, not scenario IDs: the verification layer decides.
 */
export const BEHAVIOURS = ['honest', 'tamper_after_signing', 'sign_different_terms', 'replay', 'omit_delegation', 'self_signed_delegation', 'forged_delegation', 'foreign_issuer', 'wrong_key_signature', 'stale_request', 'unregistered_key', 'unsigned'] as const;
export type Behaviour = (typeof BEHAVIOURS)[number];
export type Draft = { reference: string; document: 'QUOTE' | 'INVOICE'; currency: string; items: { name: string; category: string; quantity: number; unit_amount_minor: number }[]; payment_destination: string; expires_in_s?: number };
type Api = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>;

async function identity(db: DB, ws: string, agentId: string, behaviour: Behaviour) {
  const agent = one<any>(db, 'SELECT * FROM agents WHERE id = ? AND workspace_id = ?', agentId, ws);
  if (!agent) throw new Error('That agent does not exist.');
  const key = one<any>(db, 'SELECT private_pem FROM runtime_agent_keys WHERE agent_id = ?', agent.id);
  if (!key) throw new Error('This agent signs with its own key, outside ProxyProof. Use its own client.');
  const org = one<any>(db, 'SELECT * FROM principals WHERE id = ?', agent.principal_id);
  let did: string = agent.did, pem: string = key.private_pem;
  if (behaviour === 'unregistered_key') { const k = newKeyPair(); did = didKey(k.publicJwk); pem = k.privatePem; }
  // The credential the agent holds: the latest its organization ever signed for it, whatever its status now.
  let delegation: string | undefined = one<any>(db, `SELECT credential FROM delegations WHERE agent_id = ? AND credential IS NOT NULL ORDER BY approved_at DESC LIMIT 1`, agent.id)?.credential;
  if (behaviour === 'omit_delegation' || behaviour === 'unsigned') delegation = undefined;
  if (['self_signed_delegation', 'forged_delegation', 'foreign_issuer'].includes(behaviour)) {
    const other = newKeyPair();
    const issuer = behaviour === 'self_signed_delegation' ? agent.did : behaviour === 'forged_delegation' ? org.did : didKey(other.publicJwk);
    const signer = behaviour === 'self_signed_delegation' ? key.private_pem : other.privatePem;
    const mandate = { actions: agent.side === 'BUYER' ? ['purchase'] : ['quote', 'issue_invoice', 'request_payment'], max_amount_minor: 100_000_000, currencies: ['USD'], categories: ['coffee', 'equipment', 'service'], counterparties: [], destinations: [] };
    delegation = await new SignJWT({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential', 'AgentDelegationCredential'], issuer, validFrom: new Date().toISOString(), validUntil: new Date(Date.now() + 86_400_000).toISOString(), credentialSubject: { id: agent.did, role: agent.side === 'BUYER' ? 'BUYER_AGENT' : 'SELLER_AGENT', principal: { id: org.did, name: org.name }, mandate }, cnf: { jwk: J(agent.public_jwk, null) } } as any)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'vc+jwt', kid: `${issuer}#x` }).setIssuer(issuer).setSubject(agent.did).setJti(`forged_${Date.now()}`).setIssuedAt().setExpirationTime('1d').sign(await signingKey(signer));
  }
  return { agent, org, did, pem, delegation };
}

async function signed(api: Api, ws: string, publicUrl: string, id: Awaited<ReturnType<typeof identity>>, behaviour: Behaviour, p: { kind: 'OFFER' | 'ACCEPT'; counterparty: string; termsHash: string; transactionId?: string }) {
  const ch = await api('POST', `/api/v1/workspaces/${ws}/challenges`, { agent: id.did });
  if (ch.status !== 200) throw new Error(ch.json?.error ?? 'Could not get a challenge.');
  if (behaviour === 'unsigned') return '';
  return signAgentRequest({
    agentDid: id.did, agentPem: behaviour === 'wrong_key_signature' ? newKeyPair().privatePem : id.pem, audience: requestAudience(publicUrl, ws), kind: p.kind, nonce: ch.json.nonce,
    counterparty: p.counterparty, termsHash: p.termsHash, delegationHash: id.delegation ? sha256(id.delegation) : '', transactionId: p.transactionId,
    issuedAt: behaviour === 'stale_request' ? Math.floor(Date.now() / 1000) - 3600 : undefined,
  });
}

/** Seller's agent: sign and send an offer (a quote or invoice), or a revision of an existing transaction's terms. */
export async function sellerOffer(db: DB, api: Api, p: { workspaceId: string; publicUrl: string; agentId: string; buyerOrgId: string; draft: Draft; behaviour: Behaviour; transactionId?: string }) {
  const id = await identity(db, p.workspaceId, p.agentId, p.behaviour);
  const buyer = one<any>(db, 'SELECT * FROM principals WHERE id = ? AND workspace_id = ?', p.buyerOrgId, p.workspaceId);
  if (!buyer) throw new Error('That buyer organization does not exist.');
  const terms = {
    reference: p.draft.reference, document: p.draft.document, seller: id.org.did, buyer: buyer.did,
    items: p.draft.items, currency: p.draft.currency.toUpperCase(), total_minor: p.draft.items.reduce((s, i) => s + i.quantity * i.unit_amount_minor, 0),
    payment_destination: p.draft.payment_destination, expires_at: new Date(Date.now() + (p.draft.expires_in_s ?? 3600) * 1000).toISOString(),
  };
  const request = await signed(api, p.workspaceId, p.publicUrl, id, p.behaviour, { kind: 'OFFER', counterparty: buyer.did, termsHash: sha256(canonicalize(terms)) });
  // Tampering in transit, after the agent signed: the last line's price goes up and the total follows.
  let sent: any = terms;
  if (p.behaviour === 'tamper_after_signing') {
    const items = terms.items.map((i, n, a) => (n === a.length - 1 ? { ...i, unit_amount_minor: i.unit_amount_minor + 10_000 } : i));
    sent = { ...terms, items, total_minor: items.reduce((s, i) => s + i.quantity * i.unit_amount_minor, 0) };
  }
  const body = { request, delegation: id.delegation, terms: sent, transaction_id: p.transactionId };
  const first = await api('POST', `/api/v1/workspaces/${p.workspaceId}/offers`, body);
  if (p.behaviour !== 'replay') return { ...first.json, http_status: first.status };
  const second = await api('POST', `/api/v1/workspaces/${p.workspaceId}/offers`, body);
  return { ...second.json, http_status: second.status, first_attempt: first.json?.transaction_id ?? null };
}

/** Buyer's agent: read the terms from ProxyProof, then sign an acceptance of exactly those terms. */
export async function buyerAccept(db: DB, api: Api, p: { workspaceId: string; publicUrl: string; agentId: string; transactionId: string; behaviour: Behaviour }) {
  const id = await identity(db, p.workspaceId, p.agentId, p.behaviour);
  const view = await api('GET', `/api/v1/workspaces/${p.workspaceId}/transactions/${p.transactionId}`);
  if (view.status !== 200) throw new Error(view.json?.error ?? 'Could not read the transaction.');
  const terms = view.json.terms;
  if (!terms) throw new Error('This transaction has no valid terms to accept.');
  // An agent that authorizes something other than what is on the table: here, a lower total.
  const authorized = p.behaviour === 'sign_different_terms' ? { ...terms, total_minor: Math.max(1, terms.total_minor - 5_000) } : terms;
  const request = await signed(api, p.workspaceId, p.publicUrl, id, p.behaviour, { kind: 'ACCEPT', counterparty: terms.seller, termsHash: sha256(canonicalize(authorized)), transactionId: p.transactionId });
  const body = { request, delegation: id.delegation };
  const first = await api('POST', `/api/v1/workspaces/${p.workspaceId}/transactions/${p.transactionId}/accept`, body);
  if (p.behaviour !== 'replay') return { ...first.json, http_status: first.status };
  const second = await api('POST', `/api/v1/workspaces/${p.workspaceId}/transactions/${p.transactionId}/accept`, body);
  return { ...second.json, http_status: second.status };
}
