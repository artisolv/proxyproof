import { SignJWT, jwtVerify, decodeProtectedHeader, decodeJwt, errors, type JWTPayload } from 'jose';
import { one, run, type DB } from '../db/index.js';
import { sha256 } from '../core/util.js';
import { newKeyPair, publicJwkOfPem, signingKey, thumbprint, verifyKey, type PublicJwk } from './keys.js';

/**
 * The four signed objects ProxyProof uses. All are compact JWS with EdDSA (RFC 7515, RFC 8037).
 *
 * 1. Delegation credential: signed by the principal. Shaped as a W3C VC 2.0 data model credential and secured
 *    as a JWT with typ "vc+jwt", following the approach of VC-JOSE-COSE. Its cnf.jwk (RFC 7800) binds it to one
 *    agent key, the same binding technique Verifiable Intent uses for agent delegation. Not validated against
 *    the VC or VI conformance suites, so ProxyProof does not claim compliance with either.
 * 2. Agent request: signed by the agent's own key: an OFFER (seller) or ACCEPT (buyer) over the exact terms hash and a server challenge.
 * 3. Review approval: signed by the organization for one exact set of terms, when policy requires REVIEW.
 * 4. Receipt: signed by ProxyProof over its decision, verifiable with the public key at /.well-known/jwks.json.
 * 5. Execution permit: signed by ProxyProof, single-use, short-lived, bound to the terms hash and one action.
 */

export const ACTIONS = ['purchase', 'research', 'quote', 'issue_invoice', 'request_payment', 'delegate'] as const;
export type Action = (typeof ACTIONS)[number];
export type Mandate = {
  actions: Action[];
  max_amount_minor: number;
  currencies: string[];
  categories: string[];
  /** DIDs of the counterparties this agent may deal with. */
  counterparties: string[];
  /** Sellers only: PayPal accounts payments may be requested into. */
  destinations?: string[];
  /** Whether this agent may sub-delegate a narrower slice of this authority to another agent. */
  may_delegate?: boolean;
  /** Amounts above this need the principal to confirm the specific transaction. */
  step_up_above_minor?: number | null;
};
export type DelegationClaims = JWTPayload & {
  '@context': string[]; type: string[]; issuer: string; validFrom: string; validUntil: string;
  credentialSubject: { id: string; role: 'BUYER_AGENT' | 'SELLER_AGENT'; principal: { id: string; name: string }; mandate: Mandate };
  credentialStatus: { id: string; type: string };
  cnf: { jwk: PublicJwk };
};

const kidFor = (did: string) => `${did}#${did.slice('did:key:'.length)}`;

export async function issueDelegationCredential(p: {
  id: string; principalDid: string; principalName: string; principalPem: string; agentDid: string; agentJwk: PublicJwk;
  role: 'BUYER_AGENT' | 'SELLER_AGENT'; mandate: Mandate; validFrom: string; validUntil: string; statusUrl: string;
}): Promise<string> {
  const vc = {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'AgentDelegationCredential'],
    id: `urn:proxyproof:delegation:${p.id}`,
    issuer: p.principalDid,
    validFrom: p.validFrom,
    validUntil: p.validUntil,
    credentialSubject: { id: p.agentDid, role: p.role, principal: { id: p.principalDid, name: p.principalName }, mandate: p.mandate },
    credentialStatus: { id: p.statusUrl, type: 'ProxyProofDelegationStatus' },
    cnf: { jwk: p.agentJwk },
  };
  return new SignJWT(vc as any)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'vc+jwt', kid: kidFor(p.principalDid) })
    .setIssuer(p.principalDid).setSubject(p.agentDid).setJti(p.id)
    .setIssuedAt(Math.floor(Date.parse(p.validFrom) / 1000))
    .setNotBefore(Math.floor(Date.parse(p.validFrom) / 1000))
    .setExpirationTime(Math.floor(Date.parse(p.validUntil) / 1000))
    .sign(await signingKey(p.principalPem));
}

export type DelegationResult =
  | { ok: true; claims: DelegationClaims }
  | { ok: false; code: 'MISSING' | 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID'; claims?: DelegationClaims };

/** Verifies the credential against the key of the principal it names. Expiry is reported separately from forgery. */
export async function verifyDelegationCredential(jwt: string | undefined, principalJwk: PublicJwk): Promise<DelegationResult> {
  if (!jwt) return { ok: false, code: 'MISSING' };
  let decoded: DelegationClaims;
  try { decoded = decodeJwt(jwt) as DelegationClaims; if (decodeProtectedHeader(jwt).typ !== 'vc+jwt') return { ok: false, code: 'MALFORMED' }; } catch { return { ok: false, code: 'MALFORMED' }; }
  try {
    const { payload } = await jwtVerify(jwt, await verifyKey(principalJwk), { algorithms: ['EdDSA'], typ: 'vc+jwt', clockTolerance: 5 });
    return { ok: true, claims: payload as DelegationClaims };
  } catch (e) {
    if (e instanceof errors.JWTExpired) return { ok: false, code: 'EXPIRED', claims: decoded };
    if (e instanceof errors.JWTClaimValidationFailed && e.claim === 'nbf') return { ok: false, code: 'NOT_YET_VALID', claims: decoded };
    return { ok: false, code: 'BAD_SIGNATURE', claims: decoded };
  }
}
export const peekIssuer = (jwt: string | undefined): string | null => { try { return jwt ? String(decodeJwt(jwt).iss ?? '') || null : null; } catch { return null; } };

export type RequestKind = 'OFFER' | 'ACCEPT';
export type RequestClaims = JWTPayload & { kind: RequestKind; nonce: string; counterparty: string; terms_hash: string; delegation_hash: string; transaction_id?: string };
export const requestAudience = (publicUrl: string, workspaceId: string) => `${publicUrl}/api/v1/workspaces/${workspaceId}`;

/** What an agent signs: the act (offer or acceptance), a server challenge, the exact terms hash and the delegation it relies on. */
export async function signAgentRequest(p: { agentDid: string; agentPem: string; audience: string; kind: RequestKind; nonce: string; counterparty: string; termsHash: string; delegationHash: string; transactionId?: string; issuedAt?: number }) {
  return new SignJWT({ kind: p.kind, nonce: p.nonce, counterparty: p.counterparty, terms_hash: p.termsHash, delegation_hash: p.delegationHash, ...(p.transactionId ? { transaction_id: p.transactionId } : {}) })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'agent-request+jwt', kid: kidFor(p.agentDid) })
    .setIssuer(p.agentDid).setAudience(p.audience).setIssuedAt(p.issuedAt ?? Math.floor(Date.now() / 1000)).setJti(p.nonce)
    .sign(await signingKey(p.agentPem));
}
export function peekRequest(jws: string | undefined): { header: any; claims: Partial<RequestClaims> } | null {
  try { return jws ? { header: decodeProtectedHeader(jws), claims: decodeJwt(jws) as Partial<RequestClaims> } : null; } catch { return null; }
}
export async function verifyAgentRequest(jws: string, agentJwk: PublicJwk, audience: string) {
  const { payload } = await jwtVerify(jws, await verifyKey(agentJwk), { algorithms: ['EdDSA'], typ: 'agent-request+jwt', audience, clockTolerance: 5 });
  return payload as RequestClaims;
}

/** The organization's approval of one exact transaction, by terms hash. Used when policy requires REVIEW. */
export async function signConfirmation(p: { principalDid: string; principalPem: string; transactionId: string; transactionHash: string }) {
  return new SignJWT({ terms_hash: p.transactionHash, decision: 'APPROVED' })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'transaction-confirmation+jwt', kid: kidFor(p.principalDid) })
    .setIssuer(p.principalDid).setSubject(p.transactionId).setIssuedAt().sign(await signingKey(p.principalPem));
}
export async function verifyConfirmation(jws: string, principalJwk: PublicJwk, transactionId: string, transactionHash: string) {
  try {
    const { payload } = await jwtVerify(jws, await verifyKey(principalJwk), { algorithms: ['EdDSA'], typ: 'transaction-confirmation+jwt', subject: transactionId });
    return payload.terms_hash === transactionHash && payload.decision === 'APPROVED';
  } catch { return false; }
}

/** ProxyProof's own signing key for receipts. Generated into the database on first use; only the public half is published. */
export function receiptKey(db: DB) {
  let pem = one<{ value: string }>(db, `SELECT value FROM server_secrets WHERE name = 'receipt_signing_key'`)?.value;
  if (!pem) { pem = newKeyPair().privatePem; run(db, `INSERT INTO server_secrets (name, value) VALUES ('receipt_signing_key', ?)`, pem); }
  return { privatePem: pem, publicJwk: publicJwkOfPem(pem) };
}
export async function jwks(db: DB) {
  const { publicJwk } = receiptKey(db);
  return { keys: [{ ...publicJwk, kid: await thumbprint(publicJwk), use: 'sig', alg: 'EdDSA' }] };
}
export async function signReceipt(db: DB, issuer: string, body: Record<string, unknown>) {
  const { privatePem, publicJwk } = receiptKey(db);
  return new SignJWT(body).setProtectedHeader({ alg: 'EdDSA', typ: 'proxyproof-receipt+jwt', kid: await thumbprint(publicJwk) })
    .setIssuer(issuer).setIssuedAt().sign(await signingKey(privatePem));
}
export async function verifyReceipt(db: DB, jws: string) {
  const { publicJwk } = receiptKey(db);
  const { payload } = await jwtVerify(jws, await verifyKey(publicJwk), { algorithms: ['EdDSA'], typ: 'proxyproof-receipt+jwt' });
  return payload;
}
export const hashOf = (s: string) => sha256(s);

/**
 * Execution permit: a short-lived, single-use authorization for exactly one protected action on exactly one set of terms.
 * Issued only after an ALLOW decision; checked by the executor immediately before the side effect.
 */
export const PERMIT_TTL_S = 300;
export async function signPermit(db: DB, issuer: string, p: { jti: string; transactionId: string; termsHash: string; action: string; receiptHash: string }) {
  const { privatePem, publicJwk } = receiptKey(db);
  return new SignJWT({ act: p.action, terms_hash: p.termsHash, decision_receipt_sha256: p.receiptHash })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'execution-permit+jwt', kid: await thumbprint(publicJwk) })
    .setIssuer(issuer).setAudience('proxyproof-executor').setSubject(p.transactionId).setJti(p.jti).setIssuedAt().setExpirationTime(`${PERMIT_TTL_S}s`)
    .sign(await signingKey(privatePem));
}
export async function verifyPermit(db: DB, jws: string) {
  const { publicJwk } = receiptKey(db);
  const { payload } = await jwtVerify(jws, await verifyKey(publicJwk), { algorithms: ['EdDSA'], typ: 'execution-permit+jwt', audience: 'proxyproof-executor' });
  return payload as JWTPayload & { act: string; terms_hash: string; decision_receipt_sha256: string };
}
