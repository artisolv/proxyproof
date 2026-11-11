import { randomBytes } from 'node:crypto';
import { all, one, run, type DB } from '../db/index.js';
import { canonicalize, formatMinor, newId, nowIso, sha256 } from '../core/util.js';
import { appendAudit, verifyChain, type Actor } from '../core/ledger.js';
import { PERMIT_TTL_S, jwks, signConfirmation, signPermit, signReceipt, verifyConfirmation, verifyReceipt } from './credentials.js';
import { Conflict, NotFound, parseJson as J } from './registry.js';
import { parseTerms, termsHash, verifyParty, type Check, type PartyResult, type TermsT } from './party.js';

/**
 * One commercial transaction, two independently verified authority chains, one decision.
 *  - The seller's agent submits an OFFER: signed terms (quote or invoice) plus its business delegation.
 *  - The buyer's agent submits an ACCEPT: a signature over the same terms hash plus its purchasing mandate.
 *  - ProxyProof verifies each side on its own, matches both to the exact same terms, and decides.
 * Decisions (ALLOW / HOLD / REVIEW / DENY) are kept apart from payment state, which only the executor changes.
 */
export const POLICY_VERSION = 'proxyproof-policy-1';
export type TrustCtx = { db: DB; publicUrl: string };
export type Decision = 'ALLOW' | 'HOLD' | 'REVIEW' | 'DENY';
type PartyInput = { request: string; delegation?: string };
const CHALLENGE_TTL_MS = 5 * 60_000;

export function issueChallenge(db: DB, ws: string, agentDid: string) {
  if (!/^did:key:z[1-9A-HJ-NP-Za-km-z]{20,80}$/.test(agentDid)) throw new Conflict('agent must be a did:key identifier.');
  const nonce = randomBytes(24).toString('base64url');
  const expires_at = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  run(db, 'INSERT INTO challenges (nonce, workspace_id, agent_did, expires_at) VALUES (?,?,?,?)', nonce, ws, agentDid, expires_at);
  return { nonce, expires_at };
}

const mcheck = (key: string, label: string, state: Check['state'], detail: string, code?: string): Check => ({ key, group: 'match', label, state, detail, code });

/** Both sides verified and matched to the same terms, then the deterministic policy. */
async function decide(ctx: TrustCtx, ws: string, txId: string, seller: PartyInput, buyer: PartyInput | null, opts: { reevaluate: { seller: boolean; buyer: boolean }; reviewApproval?: string | null }) {
  const { db } = ctx;
  const body = J<any>(one<any>(db, 'SELECT terms FROM commerce_transactions WHERE id = ?', txId)?.terms, null);
  const presented = (seller as any).terms ?? body;
  const terms = parseTerms(presented);
  const hash = terms ? termsHash(presented as TermsT) : null;
  const s = await verifyParty(db, ws, 'SELLER', seller, terms, { publicUrl: ctx.publicUrl, transactionId: txId, reevaluate: opts.reevaluate.seller });
  const b: PartyResult | null = buyer ? await verifyParty(db, ws, 'BUYER', buyer, terms, { publicUrl: ctx.publicUrl, transactionId: txId, reevaluate: opts.reevaluate.buyer }) : null;

  // The match: both agents must have signed exactly these terms, for this transaction, before they expire.
  const match: Check[] = [];
  if (!terms) match.push(mcheck('seller_terms', 'Seller signed these exact terms', 'fail', 'The terms are incomplete or malformed.', 'TERMS_MALFORMED'));
  else if (s.claims && s.claims.terms_hash !== hash) match.push(mcheck('seller_terms', 'Seller signed these exact terms', 'fail', 'These terms differ from what the seller’s agent signed. They were changed after signing.', 'TERMS_MODIFIED'));
  else if (!s.claims) match.push(mcheck('seller_terms', 'Seller signed these exact terms', 'not_reached', 'Not reached: the seller’s signature could not be verified.'));
  else match.push(mcheck('seller_terms', 'Seller signed these exact terms', 'pass', `Terms hash ${hash!.slice(0, 12)}… signed by the seller’s agent.`));
  if (!b) match.push(mcheck('buyer_terms', 'Buyer authorized the same terms', 'hold', 'Waiting for the buyer’s agent to authorize these exact terms.', 'BUYER_AUTHORIZATION_PENDING'));
  else if (!b.claims) match.push(mcheck('buyer_terms', 'Buyer authorized the same terms', 'not_reached', 'Not reached: the buyer’s signature could not be verified.'));
  else if (b.claims.transaction_id !== txId) match.push(mcheck('buyer_terms', 'Buyer authorized the same terms', 'fail', 'The buyer’s agent signed for a different transaction.', 'TRANSACTION_MISMATCH'));
  else if (b.claims.terms_hash !== hash) match.push(mcheck('buyer_terms', 'Buyer authorized the same terms', 'fail', 'The buyer’s agent authorized different terms from the ones on this transaction. A new authorization is required.', 'TERMS_MISMATCH'));
  else match.push(mcheck('buyer_terms', 'Buyer authorized the same terms', 'pass', 'Both agents signed the identical terms hash: same parties, items, amount, currency and payment destination.'));
  if (terms) {
    if (Date.parse(terms.expires_at) <= Date.now()) match.push(mcheck('expiry', 'Terms still open', 'fail', `The ${terms.document.toLowerCase()} expired at ${terms.expires_at}.`, 'TERMS_EXPIRED'));
    else match.push(mcheck('expiry', 'Terms still open', 'pass', `Open until ${new Date(terms.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.`));
    const t = b?.mandate?.step_up_above_minor;
    if (b && !b.failed && t && terms.total_minor > t) {
      const ok = opts.reviewApproval && b.org ? await verifyConfirmation(opts.reviewApproval, J(b.org.public_jwk, null)!, txId, hash!) : false;
      match.push(ok ? mcheck('review', 'Policy approval', 'pass', `${b.org.name} approved this exact transaction (above ${formatMinor(t, terms.currency)}).`)
        : mcheck('review', 'Policy approval', 'review', `Above ${formatMinor(t, terms.currency)}, ${b.org.name} must approve this exact transaction.`, 'REVIEW_REQUIRED'));
    }
  }

  const all_ = [...s.checks, ...(b?.checks ?? []), ...match];
  const reasons = all_.filter((c) => ['fail', 'hold', 'review'].includes(c.state)).map((c) => ({ code: c.code ?? c.key.toUpperCase(), side: c.group, state: c.state, message: c.detail }));
  const decision: Decision = reasons.some((r) => r.state === 'fail') ? 'DENY' : reasons.some((r) => r.state === 'hold') ? 'HOLD' : reasons.some((r) => r.state === 'review') ? 'REVIEW' : 'ALLOW';
  return { s, b, match, terms, hash, reasons, decision };
}

const evidenceOf = (p: PartyResult, input: PartyInput) => ({
  request: input.request, delegation: input.delegation ?? null, checks: p.checks, agent_did: p.agent?.did ?? (p.claims?.iss ?? null),
  agent_id: p.agent?.id ?? null, org_id: p.org?.id ?? null, delegation_id: p.delegationId,
});

async function receiptFor(ctx: TrustCtx, txId: string, version: number, d: Awaited<ReturnType<typeof decide>>) {
  return signReceipt(ctx.db, ctx.publicUrl, {
    sub: txId, version, policy_version: POLICY_VERSION, decision: d.decision, terms_hash: d.hash,
    seller: { agent: d.s.agent?.did ?? null, organization: d.s.org?.did ?? null, delegation_id: d.s.delegationId },
    buyer: d.b ? { agent: d.b.agent?.did ?? null, organization: d.b.org?.did ?? null, delegation_id: d.b.delegationId } : null,
    checks: [...d.s.checks, ...(d.b?.checks ?? []), ...d.match].map((c) => ({ group: c.group, key: c.key, state: c.state, code: c.code ?? null })),
  });
}

/** Seller's agent proposes (or revises) terms. A revision voids the buyer's earlier authorization and any unused permit. */
export async function submitOffer(ctx: TrustCtx, ws: string, input: PartyInput & { terms: unknown; transactionId?: string }, opts: { label?: string } = {}) {
  const { db } = ctx;
  let id = input.transactionId ?? newId('txn');
  const existing = input.transactionId ? one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', input.transactionId, ws) : null;
  if (input.transactionId && !existing) throw new NotFound('That transaction does not exist.');
  if (existing && ['AWAITING_BUYER_APPROVAL', 'CAPTURE_SUBMITTED', 'COMPLETED'].includes(existing.payment_state)) throw new Conflict('A payment has already started for these terms. Start a new transaction instead.');
  const d = await decide(ctx, ws, id, { ...input, terms: input.terms } as any, null, { reevaluate: { seller: false, buyer: false } });
  const version = existing ? existing.version + 1 : 1;
  const receipt = await receiptFor(ctx, id, version, d);
  const now = nowIso();
  const row = {
    terms: d.terms ? JSON.stringify(input.terms) : null, terms_hash: d.hash, document: d.terms?.document ?? null, reference: d.terms?.reference ?? null,
    amount_minor: d.terms?.total_minor ?? null, currency: d.terms?.currency ?? null,
    seller_org_id: d.s.org?.id ?? null, buyer_org_id: d.terms ? one<any>(db, 'SELECT id FROM principals WHERE workspace_id = ? AND did = ?', ws, d.terms.buyer)?.id ?? null : null,
    seller_agent_id: d.s.agent?.id ?? null, seller_evidence: JSON.stringify(evidenceOf(d.s, input)),
  };
  if (existing) {
    const history = J<any[]>(existing.history, []);
    history.push({ version: existing.version, terms_hash: existing.terms_hash, amount_minor: existing.amount_minor, decision: existing.decision, superseded_at: now });
    run(db, `UPDATE commerce_transactions SET version = ?, history = ?, terms = ?, terms_hash = ?, document = ?, reference = ?, amount_minor = ?, currency = ?, seller_org_id = ?, buyer_org_id = ?, seller_agent_id = ?, seller_evidence = ?,
             buyer_agent_id = NULL, buyer_evidence = NULL, match = ?, decision = ?, reasons = ?, decision_receipt = ?, review_approval = NULL, reviewed_by = NULL, reviewed_at = NULL, payment_state = 'NOT_STARTED', updated_at = ? WHERE id = ?`,
      version, JSON.stringify(history), row.terms, row.terms_hash, row.document, row.reference, row.amount_minor, row.currency, row.seller_org_id, row.buyer_org_id, row.seller_agent_id, row.seller_evidence,
      JSON.stringify(d.match), d.decision, JSON.stringify(d.reasons), receipt, now, id);
    run(db, `UPDATE execution_permits SET used_at = ?, used_result = 'VOID_TERMS_CHANGED' WHERE transaction_id = ? AND used_at IS NULL`, now, id);
    appendAudit(db, ws, 'TERMS_REVISED', { type: 'AGENT', id: d.s.agent?.did ?? 'unknown' }, id, { version, previous_terms_hash: existing.terms_hash, terms_hash: d.hash, decision: d.decision });
  } else {
    run(db, `INSERT INTO commerce_transactions (id, workspace_id, version, terms, terms_hash, document, reference, amount_minor, currency, seller_org_id, buyer_org_id, seller_agent_id, seller_evidence, match, decision, reasons, decision_receipt, label, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ws, version, row.terms, row.terms_hash, row.document, row.reference, row.amount_minor, row.currency, row.seller_org_id, row.buyer_org_id, row.seller_agent_id, row.seller_evidence,
      JSON.stringify(d.match), d.decision, JSON.stringify(d.reasons), receipt, opts.label ?? null, now, now);
    appendAudit(db, ws, 'OFFER_VERIFIED', { type: 'AGENT', id: d.s.agent?.did ?? 'unknown' }, id, { terms_hash: d.hash, seller_failed: d.s.failed, decision: d.decision });
  }
  if (d.s.agent) run(db, 'UPDATE agents SET last_seen_at = ? WHERE id = ?', now, d.s.agent.id);
  return id;
}

/** Buyer's agent authorizes the transaction's current terms. On ALLOW a single-use execution permit is issued. */
export async function submitAcceptance(ctx: TrustCtx, ws: string, txId: string, input: PartyInput) {
  const { db } = ctx;
  const tx = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws);
  if (!tx) throw new NotFound('That transaction does not exist.');
  if (tx.payment_state !== 'NOT_STARTED' && tx.payment_state !== 'FAILED') throw new Conflict('A payment has already started for this transaction.');
  const sellerIn = J<any>(tx.seller_evidence, {});
  const d = await decide(ctx, ws, txId, { request: sellerIn.request, delegation: sellerIn.delegation ?? undefined }, input, { reevaluate: { seller: true, buyer: false }, reviewApproval: null });
  const receipt = await receiptFor(ctx, txId, tx.version, d);
  run(db, `UPDATE commerce_transactions SET buyer_agent_id = ?, buyer_evidence = ?, match = ?, decision = ?, reasons = ?, decision_receipt = ?, review_approval = NULL, updated_at = ? WHERE id = ?`,
    d.b!.agent?.id ?? null, JSON.stringify(evidenceOf(d.b!, input)), JSON.stringify(d.match), d.decision, JSON.stringify(d.reasons), receipt, nowIso(), txId);
  if (d.b!.agent) run(db, 'UPDATE agents SET last_seen_at = ? WHERE id = ?', nowIso(), d.b!.agent.id);
  appendAudit(db, ws, 'BILATERAL_DECISION', { type: 'AGENT', id: d.b!.agent?.did ?? 'unknown' }, txId, { decision: d.decision, terms_hash: d.hash, reasons: d.reasons.map((r) => r.code), receipt_sha256: sha256(receipt) });
  const permit = d.decision === 'ALLOW' ? await issuePermit(ctx, ws, txId) : null;
  return { decision: d.decision, permit };
}

/** Re-runs both sides on the stored evidence. Used by recheck, by review approval and by the executor before any side effect. */
export async function reevaluate(ctx: TrustCtx, ws: string, txId: string, actor: Actor, opts: { persist?: boolean } = { persist: true }) {
  const { db } = ctx;
  const tx = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws);
  if (!tx) throw new NotFound('That transaction does not exist.');
  const sIn = J<any>(tx.seller_evidence, {}), bIn = tx.buyer_evidence ? J<any>(tx.buyer_evidence, {}) : null;
  const d = await decide(ctx, ws, txId, { request: sIn.request, delegation: sIn.delegation ?? undefined }, bIn ? { request: bIn.request, delegation: bIn.delegation ?? undefined } : null, { reevaluate: { seller: true, buyer: true }, reviewApproval: tx.review_approval });
  if (opts.persist !== false) {
    const receipt = await receiptFor(ctx, txId, tx.version, d);
    run(db, 'UPDATE commerce_transactions SET match = ?, decision = ?, reasons = ?, decision_receipt = ?, updated_at = ? WHERE id = ?', JSON.stringify(d.match), d.decision, JSON.stringify(d.reasons), receipt, nowIso(), txId);
    if (d.b) run(db, 'UPDATE commerce_transactions SET buyer_evidence = ? WHERE id = ?', JSON.stringify(evidenceOf(d.b, bIn)), txId);
    run(db, 'UPDATE commerce_transactions SET seller_evidence = ? WHERE id = ?', JSON.stringify(evidenceOf(d.s, sIn)), txId);
    appendAudit(db, ws, 'TRANSACTION_REEVALUATED', actor, txId, { decision: d.decision, reasons: d.reasons.map((r) => r.code) });
  }
  return d;
}

export async function recheck(ctx: TrustCtx, ws: string, txId: string, actor: Actor) {
  const tx = one<any>(ctx.db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws);
  if (!tx) throw new NotFound('That transaction does not exist.');
  if (tx.decision !== 'HOLD') throw new Conflict('Only a held transaction can be checked again.');
  const d = await reevaluate(ctx, ws, txId, actor);
  return { decision: d.decision, permit: d.decision === 'ALLOW' ? await issuePermit(ctx, ws, txId) : null };
}

/** REVIEW: the buyer organization approves these exact terms, through the authenticated session that already speaks for it. */
export async function approveReview(ctx: TrustCtx, ws: string, txId: string, user: { id: string; name: string }) {
  const { db } = ctx;
  const tx = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws);
  if (!tx) throw new NotFound('That transaction does not exist.');
  if (tx.decision !== 'REVIEW') throw new Conflict('This transaction is not waiting for a review.');
  const org = one<any>(db, 'SELECT * FROM principals WHERE id = ?', J<any>(tx.buyer_evidence, {}).org_id);
  const key = one<any>(db, 'SELECT private_pem FROM principal_keys WHERE principal_id = ?', org.id);
  const approval = await signConfirmation({ principalDid: org.did, principalPem: key.private_pem, transactionId: txId, transactionHash: tx.terms_hash });
  run(db, 'UPDATE commerce_transactions SET review_approval = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', approval, user.id, nowIso(), txId);
  appendAudit(db, ws, 'REVIEW_APPROVED', { type: 'USER', id: user.id }, txId, { organization: org.name, terms_hash: tx.terms_hash });
  const d = await reevaluate(ctx, ws, txId, { type: 'USER', id: user.id });
  return { decision: d.decision, permit: d.decision === 'ALLOW' ? await issuePermit(ctx, ws, txId) : null };
}

async function issuePermit(ctx: TrustCtx, ws: string, txId: string) {
  const { db } = ctx;
  const tx = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId);
  const jti = newId('pmt');
  const jws = await signPermit(db, ctx.publicUrl, { jti, transactionId: txId, termsHash: tx.terms_hash, action: 'create_checkout', receiptHash: sha256(tx.decision_receipt) });
  run(db, 'INSERT INTO execution_permits (jti, workspace_id, transaction_id, terms_hash, action, issued_at, expires_at) VALUES (?,?,?,?,?,?,?)', jti, ws, txId, tx.terms_hash, 'create_checkout', nowIso(), new Date(Date.now() + PERMIT_TTL_S * 1000).toISOString());
  appendAudit(db, ws, 'PERMIT_ISSUED', { type: 'SYSTEM' }, txId, { jti, action: 'create_checkout', terms_hash: tx.terms_hash, ttl_s: PERMIT_TTL_S });
  return { jws, jti, expires_in_s: PERMIT_TTL_S, action: 'create_checkout' };
}

// ---------- Views ----------

export function transactionView(db: DB, tx: any) {
  const name = (table: string, id: string | null) => (id ? one<any>(db, `SELECT * FROM ${table} WHERE id = ?`, id) : null);
  const s = J<any>(tx.seller_evidence, {}), b = tx.buyer_evidence ? J<any>(tx.buyer_evidence, {}) : null;
  const sa = name('agents', tx.seller_agent_id), ba = name('agents', tx.buyer_agent_id);
  const so = name('principals', tx.seller_org_id), bo = name('principals', tx.buyer_org_id);
  const attempt = one<any>(db, 'SELECT * FROM payment_attempts WHERE transaction_id = ? ORDER BY created_at DESC LIMIT 1', tx.id);
  const permits = all<any>(db, 'SELECT jti, action, issued_at, expires_at, used_at, used_result FROM execution_permits WHERE transaction_id = ? ORDER BY issued_at', tx.id);
  const agentView = (a: any, did: string | null) => a ? { id: a.id, name: a.name, provider: a.provider, connection: a.connection, assurance: a.assurance, did: a.did } : did ? { id: null, name: 'Unknown agent', provider: '—', connection: '—', assurance: 'None: key not registered', did } : null;
  return {
    id: tx.id, version: tx.version, history: J(tx.history, []), label: tx.label,
    terms: J(tx.terms, null), terms_hash: tx.terms_hash, document: tx.document, reference: tx.reference,
    amount_minor: tx.amount_minor, currency: tx.currency, amount: tx.amount_minor != null ? formatMinor(tx.amount_minor, tx.currency ?? 'USD') : null,
    seller: { agent: agentView(sa, s.agent_did), organization: so ? { id: so.id, name: so.name, did: so.did, status: so.status } : null, delegation_id: s.delegation_id, checks: s.checks ?? [] },
    buyer: b ? { agent: agentView(ba, b.agent_did), organization: bo ? { id: bo.id, name: bo.name, did: bo.did, status: bo.status } : null, delegation_id: b.delegation_id, checks: b.checks ?? [] } : { agent: null, organization: bo ? { id: bo.id, name: bo.name, did: bo.did, status: bo.status } : null, delegation_id: null, checks: [] },
    match: J(tx.match, []), decision: tx.decision, reasons: J(tx.reasons, []), decision_receipt: tx.decision_receipt,
    reviewed_at: tx.reviewed_at, permits,
    payment_state: tx.payment_state,
    payment: attempt ? { rail: attempt.rail, status: attempt.status, provider_ref: attempt.provider_ref, provider_status: attempt.provider_status, payer_link: attempt.payer_link, failure: attempt.failure, confirmed_by: attempt.confirmed_by, permit_jti: attempt.permit_jti } : null,
    created_at: tx.created_at, updated_at: tx.updated_at,
  };
}
export const listTransactions = (db: DB, ws: string, limit = 60) => all<any>(db, 'SELECT * FROM commerce_transactions WHERE workspace_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?', ws, limit).map((t) => transactionView(db, t));

/**
 * The bilateral evidence bundle: both authority chains as presented (requests and credentials), every check, the match,
 * the decision receipt, permits and the provider outcome, plus the audit-chain head. Signed by ProxyProof over its
 * canonical SHA-256 so anyone can check it was not altered after export.
 */
export async function proofBundle(ctx: TrustCtx, ws: string, txId: string) {
  const { db } = ctx;
  const tx = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws);
  if (!tx) throw new NotFound('That transaction does not exist.');
  const v = transactionView(db, tx);
  const s = J<any>(tx.seller_evidence, {}), b = tx.buyer_evidence ? J<any>(tx.buyer_evidence, {}) : null;
  const org = (id: string | null) => (id ? one<any>(db, 'SELECT name, role, did, public_jwk, status, verification_method FROM principals WHERE id = ?', id) : null);
  const bundle = {
    format: 'proxyproof-evidence-bundle/1', generated_at: nowIso(), policy_version: POLICY_VERSION,
    transaction: { id: tx.id, version: tx.version, terms: J(tx.terms, null), terms_hash: tx.terms_hash, history: J(tx.history, []) },
    seller: { organization: org(tx.seller_org_id), agent: v.seller.agent, request: s.request ?? null, delegation_credential: s.delegation ?? null, checks: s.checks ?? [] },
    buyer: b ? { organization: org(tx.buyer_org_id), agent: v.buyer.agent, request: b.request ?? null, delegation_credential: b.delegation ?? null, checks: b.checks ?? [] } : null,
    match: J(tx.match, []), decision: tx.decision, reasons: J(tx.reasons, []), decision_receipt: tx.decision_receipt,
    review_approval: tx.review_approval ?? null, permits: v.permits,
    payment: { state: tx.payment_state, ...(v.payment ?? {}) },
    audit_chain: verifyChain(db, ws), verification_keys: await jwks(db),
  };
  const digest = sha256(canonicalize(JSON.parse(JSON.stringify(bundle))));
  const signature = await signReceipt(db, ctx.publicUrl, { typ_hint: 'evidence-bundle', bundle_sha256: digest, sub: tx.id });
  return { bundle, bundle_sha256: digest, signature };
}

/** Independent check of an exported bundle: the signature, the digest, and the decision receipt inside it. */
export async function verifyBundle(db: DB, input: { bundle: unknown; signature: string }) {
  const result: { signature: boolean; digest_matches: boolean; decision_receipt: boolean; decision?: string } = { signature: false, digest_matches: false, decision_receipt: false };
  try {
    const sig = await verifyReceipt(db, input.signature);
    result.signature = true;
    result.digest_matches = sig.bundle_sha256 === sha256(canonicalize(input.bundle));
    const r = await verifyReceipt(db, (input.bundle as any)?.decision_receipt);
    result.decision_receipt = r.sub === (input.bundle as any)?.transaction?.id && r.terms_hash === (input.bundle as any)?.transaction?.terms_hash;
    result.decision = r.decision as string;
  } catch { /* leave false */ }
  return result;
}
