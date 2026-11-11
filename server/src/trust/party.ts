import { z } from 'zod';
import { one, run, type DB } from '../db/index.js';
import { canonicalize, formatMinor, nowIso, sha256 } from '../core/util.js';
import { thumbprint, type PublicJwk } from './keys.js';
import { peekIssuer, peekRequest, requestAudience, verifyAgentRequest, verifyDelegationCredential, type DelegationClaims, type Mandate, type RequestClaims } from './credentials.js';
import { delegationStatus, parseJson as J, StatusUnavailable } from './registry.js';

/**
 * Verifies ONE side of a bilateral transaction: is this agent who it claims to be, does its organization exist and is it
 * trusted, did that organization delegate this exact action to this exact agent key, and is the delegation still in force.
 * The same function verifies the seller's agent (offer) and the buyer's agent (acceptance). Deterministic: no model.
 */

export const Item = z.object({ name: z.string().min(1).max(120), category: z.string().min(1).max(40), quantity: z.number().int().positive().max(10_000), unit_amount_minor: z.number().int().nonnegative().max(100_000_000) }).strict();
/** The commercial terms both agents sign. Canonical JSON (sorted keys, integers only) hashed with SHA-256. */
export const Terms = z.object({
  reference: z.string().min(1).max(60),
  document: z.enum(['QUOTE', 'INVOICE']),
  seller: z.string().startsWith('did:key:'),
  buyer: z.string().startsWith('did:key:'),
  items: z.array(Item).min(1).max(50),
  currency: z.string().length(3),
  total_minor: z.number().int().positive().max(100_000_000),
  payment_destination: z.string().min(3).max(200),
  expires_at: z.string().max(40),
}).strict();
export type TermsT = z.infer<typeof Terms>;
export const termsHash = (t: TermsT) => sha256(canonicalize(t));

export type Role = 'SELLER' | 'BUYER';
export type CheckState = 'pass' | 'hold' | 'review' | 'fail' | 'not_reached';
export type Check = { key: string; group: 'seller' | 'buyer' | 'match'; label: string; state: CheckState; detail: string; code?: string };
export const SIDE_CHECKS: [string, string][] = [
  ['identity', 'Agent identity'], ['signature', 'Signature and key possession'], ['replay', 'Freshness and replay'],
  ['organization', 'Organization trust'], ['delegation', 'Signed delegation'], ['validity', 'Expiry and revocation'],
  ['scope', 'Permitted action and limits'], ['counterparty', 'Approved counterparty'],
];
export const SELLER_EXTRA: [string, string][] = [['destination', 'Payment destination']];
const REQUEST_MAX_AGE_S = 300;

export type PartyResult = {
  role: Role; checks: Check[]; failed: boolean; held: boolean;
  agent: any | null; org: any | null; delegationId: string | null; mandate: Mandate | null; claims: RequestClaims | null;
};

export async function verifyParty(db: DB, ws: string, role: Role, input: { request: string; delegation?: string }, terms: TermsT | null, opts: { publicUrl: string; transactionId: string; reevaluate?: boolean }): Promise<PartyResult> {
  const group = role === 'SELLER' ? 'seller' : 'buyer';
  const keys = role === 'SELLER' ? [...SIDE_CHECKS, ...SELLER_EXTRA] : SIDE_CHECKS;
  const checks: Check[] = [];
  let stopped = false;
  const record = (key: string, state: CheckState, detail: string, code?: string) => {
    const label = keys.find(([k]) => k === key)![1];
    if (stopped) { checks.push({ key, group, label, state: 'not_reached', detail: 'Not reached: an earlier check failed.' }); return; }
    checks.push({ key, group, label, state, detail, code });
    if (state === 'fail') stopped = true;
  };
  const who = role === 'SELLER' ? 'seller' : 'buyer';
  const out: PartyResult = { role, checks, failed: false, held: false, agent: null, org: null, delegationId: null, mandate: null, claims: null };

  // 1. Identity: only a key registered against an organization is known.
  const peek = peekRequest(input.request);
  const did = typeof peek?.claims.iss === 'string' ? peek.claims.iss : null;
  const agent = did ? one<any>(db, 'SELECT * FROM agents WHERE workspace_id = ? AND did = ?', ws, did) : null;
  out.agent = agent ?? null;
  if (!peek || !did) record('identity', 'fail', `The ${who} side sent no signed agent request.`, 'REQUEST_MALFORMED');
  else if (!agent) record('identity', 'fail', `No organization has registered this ${who} agent (${did.slice(0, 22)}…). An unknown key cannot act for anyone.`, 'AGENT_UNKNOWN');
  else if (agent.side !== role) record('identity', 'fail', `${agent.name} is registered as a ${agent.side.toLowerCase()} agent, not a ${who} agent.`, 'AGENT_WRONG_SIDE');
  else record('identity', 'pass', `${agent.name} (${agent.provider}), key ${agent.thumbprint.slice(0, 10)}…, assurance: ${agent.assurance}.`);
  const agentJwk: PublicJwk | null = agent ? J(agent.public_jwk, null) : null;

  // 2. Proof of possession, addressed to this workspace, for this kind of act.
  let claims: RequestClaims | null = null;
  const expectKind = role === 'SELLER' ? 'OFFER' : 'ACCEPT';
  if (!stopped) {
    try {
      claims = await verifyAgentRequest(input.request, agentJwk!, requestAudience(opts.publicUrl, ws));
      if (claims.kind !== expectKind) record('signature', 'fail', `The signed request is a ${String(claims.kind)}, not a ${expectKind.toLowerCase()}.`, 'REQUEST_KIND_MISMATCH');
      else record('signature', 'pass', 'Signed with the registered key (EdDSA). The agent holds the private key.');
    } catch { record('signature', 'fail', `The ${who} agent's signature does not match its registered key, or the request was addressed elsewhere.`, 'SIGNATURE_INVALID'); }
  } else record('signature', 'fail', '');
  out.claims = claims;

  // 3. Freshness and replay: a nonce ProxyProof issued to this key, usable once.
  if (!stopped && claims) {
    const ch = one<any>(db, 'SELECT * FROM challenges WHERE nonce = ? AND workspace_id = ?', String(claims.nonce), ws);
    const ageS = Math.abs(Date.now() / 1000 - (claims.iat ?? 0));
    const mine = `${opts.transactionId}:${role}`;
    if (!ch || ch.agent_did !== agent.did) record('replay', 'fail', 'The request does not answer a challenge issued to this agent.', 'CHALLENGE_UNKNOWN');
    else if (ch.used_by && ch.used_by !== mine) record('replay', 'fail', 'This signed request was already used. Replays are refused.', 'REPLAY');
    else if (!opts.reevaluate && Date.parse(ch.expires_at) <= Date.now()) record('replay', 'fail', 'The challenge expired before the request arrived.', 'CHALLENGE_EXPIRED');
    else if (!opts.reevaluate && ageS > REQUEST_MAX_AGE_S) record('replay', 'fail', 'The request is too old to be trusted.', 'REQUEST_STALE');
    else if (!opts.reevaluate && Number(run(db, 'UPDATE challenges SET used_by = ?, used_at = ? WHERE nonce = ? AND used_by IS NULL', mine, nowIso(), ch.nonce).changes) === 0) record('replay', 'fail', 'This signed request was already used. Replays are refused.', 'REPLAY');
    else record('replay', 'pass', opts.reevaluate ? 'Same signed request, re-checked; its challenge belongs to this transaction.' : 'Fresh, single-use challenge answered.');
  } else record('replay', 'fail', '');

  // 4. The organization behind the agent: enrolled, key in force, trust established.
  const org = agent ? one<any>(db, 'SELECT * FROM principals WHERE id = ?', agent.principal_id) : null;
  out.org = org ?? null;
  if (!stopped) {
    if (org.key_status !== 'ACTIVE') record('organization', 'fail', `${org.name}'s signing key has been revoked.`, 'ORG_KEY_REVOKED');
    else if (org.status === 'SUSPENDED') record('organization', 'fail', `${org.name} is suspended.`, 'ORG_SUSPENDED');
    else if (org.status !== 'VERIFIED') record('organization', 'hold', `${org.name} has not completed enrollment. Its delegations cannot be trusted yet.`, 'ORG_NOT_ESTABLISHED');
    else record('organization', 'pass', `${org.name}, enrolled (${org.verification_method}).`);
  } else record('organization', 'fail', '');

  // 5. The delegation: signed by that organization's key, naming this agent, bound to its key.
  let dclaims: DelegationClaims | null = null, dcode: string | null = null;
  if (!stopped) {
    const res = await verifyDelegationCredential(input.delegation, J(org.public_jwk, null)!);
    if (!res.ok && res.code === 'MISSING') record('delegation', 'fail', `${agent.name} presented no delegation. Connected is not the same as authorized.`, 'DELEGATION_MISSING');
    else if (!res.ok && res.code === 'MALFORMED') record('delegation', 'fail', 'The delegation is not a valid credential.', 'DELEGATION_MALFORMED');
    else if (!res.ok && res.code === 'BAD_SIGNATURE') {
      const iss = peekIssuer(input.delegation);
      if (iss === agent.did) record('delegation', 'fail', 'The agent signed its own delegation. An agent cannot authorize itself.', 'SELF_DELEGATION');
      else if (iss && iss !== org.did) record('delegation', 'fail', `The delegation was issued by ${iss.slice(0, 22)}…, not by ${org.name}.`, 'WRONG_ISSUER');
      else record('delegation', 'fail', `The delegation's signature does not match ${org.name}'s registered key.`, 'DELEGATION_FORGED');
    } else {
      dclaims = res.claims!; dcode = res.ok ? null : res.code;
      const row = one<any>(db, 'SELECT * FROM delegations WHERE id = ? AND workspace_id = ?', String(dclaims.jti), ws);
      out.delegationId = row?.id ?? null;
      const bound = dclaims.cnf?.jwk ? await thumbprint(dclaims.cnf.jwk).catch(() => '') : '';
      if (dclaims.credentialSubject?.id !== agent.did) record('delegation', 'fail', 'The delegation names a different agent.', 'DELEGATION_WRONG_AGENT');
      else if (bound !== agent.thumbprint) record('delegation', 'fail', 'The delegation is bound to a different agent key.', 'KEY_NOT_BOUND');
      else if (claims!.delegation_hash !== sha256(input.delegation!)) record('delegation', 'fail', 'The agent signed a different delegation from the one it presented.', 'DELEGATION_NOT_BOUND');
      else if (!row || row.credential_hash !== sha256(input.delegation!)) record('delegation', 'fail', `This credential was not issued through ${org.name}'s approval.`, 'DELEGATION_UNKNOWN');
      else { out.mandate = dclaims.credentialSubject.mandate; record('delegation', 'pass', `Signed by ${org.name}, bound to this agent's key. Approved ${String(row.approved_at).slice(0, 10)}.`); }
    }
  } else record('delegation', 'fail', '');

  // 6. Still in force. An unanswerable status service means "unknown", which is held, never passed.
  if (!stopped) {
    if (dcode === 'EXPIRED') record('validity', 'fail', `The delegation expired on ${String(dclaims!.validUntil).slice(0, 10)}.`, 'DELEGATION_EXPIRED');
    else if (dcode === 'NOT_YET_VALID') record('validity', 'fail', 'The delegation is not valid yet.', 'DELEGATION_NOT_YET_VALID');
    else {
      try {
        const st = delegationStatus(db, ws, out.delegationId!);
        const row = one<any>(db, 'SELECT * FROM delegations WHERE id = ?', out.delegationId);
        if (st === 'REVOKED') record('validity', 'fail', `${row.revoked_reason ?? `${org.name} revoked this delegation`} (${String(row.revoked_at).slice(0, 10)}).`, 'DELEGATION_REVOKED');
        else if (st === 'SUPERSEDED') record('validity', 'fail', 'A newer delegation replaced this one.', 'DELEGATION_SUPERSEDED');
        else if (st !== 'ACTIVE') record('validity', 'fail', 'The delegation status is unknown.', 'DELEGATION_STATUS_UNKNOWN');
        else record('validity', 'pass', `Valid until ${String(dclaims!.validUntil).slice(0, 10)}. Not revoked${row.parent_id ? '; parent delegation also in force' : ''}.`);
      } catch (e) {
        if (e instanceof StatusUnavailable) record('validity', 'hold', 'The revocation status service did not respond, so this authority is unconfirmed. Held, not assumed valid.', 'STATUS_UNAVAILABLE');
        else throw e;
      }
    }
  } else record('validity', 'fail', '');

  // 7. The action and its limits, read from the signed mandate (not the database).
  const m = out.mandate;
  if (!stopped && terms) {
    const need = role === 'BUYER' ? ['purchase'] : terms.document === 'QUOTE' ? ['quote'] : ['issue_invoice', 'request_payment'];
    const missing = need.filter((a) => !m!.actions.includes(a as any));
    const badCat = terms.items.find((i) => !m!.categories.includes(i.category));
    const verb = role === 'BUYER' ? 'make purchases' : terms.document === 'QUOTE' ? 'issue quotes' : 'issue invoices and request payment';
    if (missing.length) record('scope', 'fail', `${org.name} authorized this agent for ${m!.actions.join(', ').replace(/_/g, ' ')} only, not to ${verb}.`, 'ACTION_NOT_PERMITTED');
    else if (!m!.currencies.includes(terms.currency)) record('scope', 'fail', `${terms.currency} is not an authorized currency (${m!.currencies.join(', ')}).`, 'CURRENCY_NOT_PERMITTED');
    else if (badCat) record('scope', 'fail', `“${badCat.category}” is outside the authorized categories (${m!.categories.join(', ')}).`, 'CATEGORY_NOT_PERMITTED');
    else if (terms.total_minor > m!.max_amount_minor) record('scope', 'fail', `${formatMinor(terms.total_minor, terms.currency)} exceeds the ${formatMinor(m!.max_amount_minor, terms.currency)} limit ${org.name} set.`, 'AMOUNT_EXCEEDS_LIMIT');
    else record('scope', 'pass', `May ${verb}, up to ${formatMinor(m!.max_amount_minor, terms.currency)}. This is ${formatMinor(terms.total_minor, terms.currency)}.`);
  } else record('scope', 'fail', stopped ? '' : 'The transaction terms are missing or malformed.', stopped ? undefined : 'TERMS_MALFORMED');

  // 8. The other organization must be one this delegation allows.
  if (!stopped && terms) {
    const ownDid = role === 'SELLER' ? terms.seller : terms.buyer;
    const cpDid = role === 'SELLER' ? terms.buyer : terms.seller;
    const cp = one<any>(db, 'SELECT * FROM principals WHERE workspace_id = ? AND did = ?', ws, cpDid);
    if (ownDid !== org.did) record('counterparty', 'fail', `The terms name a different ${who} than ${org.name}.`, 'PARTY_MISMATCH');
    else if (claims!.counterparty !== cpDid) record('counterparty', 'fail', 'The agent signed for a different counterparty.', 'COUNTERPARTY_NOT_SIGNED');
    else if (!cp) record('counterparty', 'fail', `The ${role === 'SELLER' ? 'buyer' : 'seller'} is not an enrolled organization.`, 'COUNTERPARTY_UNKNOWN');
    else if (m!.counterparties.length && !m!.counterparties.includes(cp.did)) record('counterparty', 'fail', `${org.name} has not approved this agent to deal with ${cp.name}.`, 'COUNTERPARTY_NOT_APPROVED');
    else record('counterparty', 'pass', `${cp.name} is an approved counterparty.`);
  } else record('counterparty', 'fail', '');

  // 9. Seller only: money may only go where the business itself said, and the account must be the business's.
  if (role === 'SELLER') {
    if (!stopped && terms) {
      const to = terms.payment_destination.trim().toLowerCase();
      const allowed = (m!.destinations ?? []).map((d) => d.toLowerCase());
      if (!allowed.includes(to)) record('destination', 'fail', `Asks to be paid at ${to}, which ${org.name} never authorized this agent to use.`, 'DESTINATION_NOT_AUTHORIZED');
      else if (to !== String(org.payment_account ?? '').toLowerCase()) record('destination', 'fail', `${to} is not ${org.name}'s enrolled PayPal account.`, 'DESTINATION_NOT_LINKED');
      else record('destination', 'pass', `Paid to ${org.name}'s enrolled PayPal account.`);
    } else record('destination', 'fail', '');
  }

  for (const c of checks) if (c.state === 'fail' && !c.detail) { c.state = 'not_reached'; c.detail = 'Not reached: an earlier check failed.'; }
  out.failed = checks.some((c) => c.state === 'fail');
  out.held = checks.some((c) => c.state === 'hold');
  return out;
}

export const parseTerms = (t: unknown) => { const r = Terms.safeParse(t); return r.success ? { ...r.data, currency: r.data.currency.toUpperCase() } as TermsT : null; };
export const termsHashOf = (t: unknown) => { const r = Terms.safeParse(t); return r.success ? termsHash(r.data) : null; };
