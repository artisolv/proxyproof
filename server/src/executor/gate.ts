import { errors as joseErrors } from 'jose';
import { one, run, type DB } from '../db/index.js';
import { newId, nowIso, sha256 } from '../core/util.js';
import { appendAudit, type Actor } from '../core/ledger.js';
import { verifyPermit } from '../trust/credentials.js';
import { parseJson as J } from '../trust/registry.js';
import { reevaluate, type TrustCtx } from '../trust/bilateral.js';
import { ProviderError, __issuePass, type PayPal } from './paypal.js';

/**
 * The execution boundary. The UI and the MCP server are not security boundaries; this module is.
 * A payment side effect happens only when a valid, unused, unexpired permit names this exact transaction, its current
 * terms hash and the requested action, and a live re-verification of both agents still returns ALLOW.
 */
export class GateRefused extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export type ExecutorCtx = TrustCtx & { paypal: PayPal; quota: (ws: string) => string | null };

function refuse(db: DB, ws: string, txId: string, actor: Actor, code: string, message: string): never {
  if (one(db, 'SELECT 1 FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws)) appendAudit(db, ws, 'EXECUTOR_REFUSED', actor, txId, { code });
  throw new GateRefused(code, message);
}

export async function executeWithPermit(ctx: ExecutorCtx, ws: string, txId: string, permitJws: string | undefined, actor: Actor) {
  const { db, paypal, publicUrl } = ctx;
  const tx = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', txId, ws);
  if (!tx) refuse(db, ws, txId, actor, 'NOT_FOUND', 'That transaction does not exist.');
  if (!permitJws) refuse(db, ws, txId, actor, 'PERMIT_MISSING', 'No execution permit. Protected actions run only with a permit issued after an ALLOW decision.');
  let permit: Awaited<ReturnType<typeof verifyPermit>>;
  try { permit = await verifyPermit(db, permitJws); }
  catch (e) { refuse(db, ws, txId, actor, e instanceof joseErrors.JWTExpired ? 'PERMIT_EXPIRED' : 'PERMIT_INVALID', e instanceof joseErrors.JWTExpired ? 'The execution permit has expired. Request a new decision.' : 'The execution permit is not genuine.'); }
  if (permit.sub !== txId) refuse(db, ws, txId, actor, 'PERMIT_WRONG_TRANSACTION', 'This permit was issued for a different transaction.');
  if (permit.act !== 'create_checkout') refuse(db, ws, txId, actor, 'PERMIT_WRONG_ACTION', 'This permit does not allow this action.');
  if (permit.terms_hash !== tx.terms_hash) refuse(db, ws, txId, actor, 'TERMS_CHANGED', 'The terms changed after this permit was issued. The earlier authorization no longer applies.');
  if (tx.decision !== 'ALLOW') refuse(db, ws, txId, actor, `DECISION_${tx.decision}`, `The current decision is ${tx.decision}. Nothing can be executed.`);
  if (permit.decision_receipt_sha256 !== sha256(tx.decision_receipt)) refuse(db, ws, txId, actor, 'DECISION_CHANGED', 'The decision changed after this permit was issued.');
  // Single use, claimed atomically before anything else happens.
  const claimed = run(db, `UPDATE execution_permits SET used_at = ?, used_result = 'CLAIMED' WHERE jti = ? AND workspace_id = ? AND transaction_id = ? AND used_at IS NULL`, nowIso(), String(permit.jti), ws, txId);
  if (Number(claimed.changes) === 0) refuse(db, ws, txId, actor, 'PERMIT_ALREADY_USED', 'This permit has already been used. Duplicate execution refused.');
  // Time of use: authority is re-verified on live state (revocation, expiry, keys) immediately before the side effect.
  const live = await reevaluate(ctx, ws, txId, actor);
  if (live.decision !== 'ALLOW') { run(db, `UPDATE execution_permits SET used_result = 'REFUSED_LIVE_RECHECK' WHERE jti = ?`, String(permit.jti)); refuse(db, ws, txId, actor, 'LIVE_RECHECK_FAILED', `Authority no longer holds: ${live.reasons.map((r) => r.message).join(' ')}`); }
  if (!paypal.configured) { run(db, `UPDATE execution_permits SET used_result = 'RAIL_NOT_CONFIGURED' WHERE jti = ?`, String(permit.jti)); refuse(db, ws, txId, actor, 'RAIL_NOT_CONFIGURED', 'PayPal sandbox credentials are not configured on this server, so no checkout was created.'); }
  const over = ctx.quota(ws);
  if (over) refuse(db, ws, txId, actor, 'SANDBOX_QUOTA', over);

  const attemptId = newId('pay');
  const idem = `pp-${sha256(`${txId}:${tx.terms_hash}`).slice(0, 20)}-${attemptId.slice(4, 12)}`;
  try {
    run(db, `INSERT INTO payment_attempts (id, workspace_id, transaction_id, permit_jti, terms_hash, rail, status, idempotency_key, amount_minor, currency, created_at, updated_at) VALUES (?,?,?,?,?, 'ORDERS', 'CREATED', ?,?,?,?,?)`,
      attemptId, ws, txId, String(permit.jti), tx.terms_hash, idem, tx.amount_minor, tx.currency, nowIso(), nowIso());
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) refuse(db, ws, txId, actor, 'DUPLICATE_PAYMENT', 'A payment for this transaction already exists.');
    throw e;
  }
  run(db, `UPDATE execution_permits SET used_result = 'EXECUTED' WHERE jti = ?`, String(permit.jti));
  appendAudit(db, ws, 'EXECUTION_ADMITTED', actor, txId, { attempt_id: attemptId, permit_jti: permit.jti, terms_hash: tx.terms_hash, amount_minor: tx.amount_minor, currency: tx.currency });
  const terms = J<any>(tx.terms, {});
  try {
    const r = await paypal.createOrder(__issuePass({ attemptId, transactionId: txId }), {
      idempotencyKey: idem, amountMinor: tx.amount_minor, currency: tx.currency, reference: `${terms.reference}-${txId.slice(4, 10)}`,
      description: `${terms.document === 'INVOICE' ? 'Invoice' : 'Quote'} ${terms.reference} verified by ProxyProof`, returnUrl: `${publicUrl}/paypal/return?tx=${txId}`, cancelUrl: `${publicUrl}/app?tx=${txId}`,
    });
    settle(db, attemptId, 'AWAITING_BUYER_APPROVAL', { providerRef: r.orderId, providerStatus: r.status, payerLink: r.approveUrl });
    appendAudit(db, ws, 'PROVIDER_RESPONSE', { type: 'PROVIDER', id: 'paypal-sandbox' }, txId, { rail: 'ORDERS', order_id: r.orderId, status: r.status });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('The PayPal call failed unexpectedly.', 'AMBIGUOUS');
    settle(db, attemptId, err.kind === 'DEFINITE' ? 'FAILED' : 'UNKNOWN', { failure: err.message });
    appendAudit(db, ws, 'PROVIDER_ERROR', { type: 'PROVIDER', id: 'paypal-sandbox' }, txId, { message: err.message.slice(0, 300) });
  }
  return one<any>(db, 'SELECT * FROM payment_attempts WHERE id = ?', attemptId);
}

const PAYMENT_STATE: Record<string, string> = { CREATED: 'AWAITING_BUYER_APPROVAL', AWAITING_BUYER_APPROVAL: 'AWAITING_BUYER_APPROVAL', APPROVED: 'AWAITING_BUYER_APPROVAL', CAPTURE_SUBMITTED: 'CAPTURE_SUBMITTED', COMPLETED: 'COMPLETED', FAILED: 'FAILED', UNKNOWN: 'CAPTURE_SUBMITTED' };
function settle(db: DB, attemptId: string, status: string, f: { providerRef?: string; providerStatus?: string; payerLink?: string; failure?: string; confirmedBy?: string }) {
  const a = one<any>(db, 'SELECT * FROM payment_attempts WHERE id = ?', attemptId);
  if (a.status === 'COMPLETED') return; // Nothing un-pays a confirmed payment.
  run(db, `UPDATE payment_attempts SET status = ?, provider_ref = COALESCE(?, provider_ref), provider_status = COALESCE(?, provider_status), payer_link = COALESCE(?, payer_link), failure = COALESCE(?, failure), confirmed_by = COALESCE(?, confirmed_by), updated_at = ? WHERE id = ?`,
    status, f.providerRef ?? null, f.providerStatus ?? null, f.payerLink ?? null, f.failure ?? null, f.confirmedBy ?? null, nowIso(), attemptId);
  run(db, 'UPDATE commerce_transactions SET payment_state = ?, updated_at = ? WHERE id = ?', PAYMENT_STATE[status], nowIso(), a.transaction_id);
}

/** After the buyer approves on PayPal. The redirect proves nothing: authority is re-verified, then PayPal is asked. */
export async function captureCheckout(ctx: ExecutorCtx, ws: string, txId: string, actor: Actor) {
  const { db, paypal } = ctx;
  const a = one<any>(db, `SELECT * FROM payment_attempts WHERE transaction_id = ? AND workspace_id = ? AND status <> 'FAILED' ORDER BY created_at DESC LIMIT 1`, txId, ws);
  if (!a) refuse(db, ws, txId, actor, 'NO_CHECKOUT', 'There is no checkout to complete for this transaction.');
  if (a.status === 'COMPLETED') return a;
  const tx = one<any>(db, 'SELECT terms_hash FROM commerce_transactions WHERE id = ?', txId);
  if (tx.terms_hash !== a.terms_hash) refuse(db, ws, txId, actor, 'TERMS_CHANGED', 'The terms changed after checkout started.');
  const live = await reevaluate(ctx, ws, txId, actor);
  if (live.decision !== 'ALLOW') refuse(db, ws, txId, actor, 'LIVE_RECHECK_FAILED', `Authority no longer holds: ${live.reasons.map((r) => r.message).join(' ')}`);
  try {
    const r = await paypal.captureOrder(__issuePass({ attemptId: a.id, transactionId: txId }), a.provider_ref, a.idempotency_key);
    settle(db, a.id, 'CAPTURE_SUBMITTED', { providerStatus: r.captureStatus ?? r.status });
    appendAudit(db, ws, 'PROVIDER_RESPONSE', { type: 'PROVIDER', id: 'paypal-sandbox' }, txId, { rail: 'ORDERS', status: r.status, capture_status: r.captureStatus });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('Capture failed unexpectedly.', 'AMBIGUOUS');
    appendAudit(db, ws, 'PROVIDER_ERROR', { type: 'PROVIDER', id: 'paypal-sandbox' }, txId, { message: err.message.slice(0, 300) });
    if (/ORDER_NOT_APPROVED|PAYER_ACTION_REQUIRED/.test(err.message)) refuse(db, ws, txId, actor, 'BUYER_NOT_APPROVED', 'The buyer has not approved this checkout on PayPal yet.');
  }
  return syncPayment(ctx, ws, txId);
}

/** Reads PayPal's own status through the authenticated API. This, or a verified webhook, is the only path to COMPLETED. */
export async function syncPayment(ctx: ExecutorCtx, ws: string, txId: string) {
  const { db, paypal } = ctx;
  const a = one<any>(db, 'SELECT * FROM payment_attempts WHERE transaction_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 1', txId, ws);
  if (!a || !a.provider_ref || ['COMPLETED', 'FAILED'].includes(a.status)) return a;
  const r = await paypal.getOrder(a.provider_ref);
  const next = r.captureStatus === 'COMPLETED' ? 'COMPLETED' : ['DECLINED', 'FAILED'].includes(r.captureStatus ?? '') ? 'FAILED' : r.status === 'APPROVED' ? 'APPROVED' : r.status === 'VOIDED' ? 'FAILED' : a.status;
  if (next !== a.status || (r.captureStatus ?? r.status) !== a.provider_status) settle(db, a.id, next, { providerStatus: r.captureStatus ?? r.status, confirmedBy: next === 'COMPLETED' ? 'Authenticated PayPal API lookup' : undefined, failure: next === 'FAILED' ? `PayPal reports ${r.captureStatus ?? r.status}` : undefined });
  const after = one<any>(db, 'SELECT * FROM payment_attempts WHERE id = ?', a.id);
  if (after.status === 'COMPLETED' && a.status !== 'COMPLETED') appendAudit(db, ws, 'PAYMENT_CONFIRMED', { type: 'PROVIDER', id: 'paypal-sandbox' }, txId, { via: 'api_lookup', order_id: a.provider_ref });
  return after;
}

/** Webhook intake. Unverified events change nothing; a verified event only prompts an authenticated lookup. */
export async function handleWebhook(ctx: ExecutorCtx, headers: Record<string, string | undefined>, rawBody: string) {
  const { db, paypal } = ctx;
  const payloadHash = sha256(rawBody);
  let event: any = null;
  try { event = JSON.parse(rawBody); } catch { /* rejected below */ }
  const verified = event ? await paypal.verifyWebhook(headers, rawBody) : false;
  if (!verified) {
    run(db, `INSERT INTO provider_events (id, provider_event_id, event_type, verified, rejection, payload_sha256, received_at) VALUES (?,?,?,0,?,?,?)`, newId('evt'), null, event?.event_type?.toString().slice(0, 100) ?? null, 'Signature verification failed', payloadHash, nowIso());
    return { accepted: false };
  }
  const res = event.resource ?? {};
  const ref: string | undefined = res.supplementary_data?.related_ids?.order_id ?? (event.event_type?.startsWith('CHECKOUT.ORDER') ? res.id : undefined);
  const a = ref ? one<any>(db, 'SELECT * FROM payment_attempts WHERE provider_ref = ?', ref) : undefined;
  const ins = run(db, `INSERT OR IGNORE INTO provider_events (id, provider_event_id, event_type, verified, attempt_id, payload_sha256, received_at) VALUES (?,?,?,1,?,?,?)`, newId('evt'), event.id, event.event_type, a?.id ?? null, payloadHash, nowIso());
  if (Number(ins.changes) === 0 || !a) return { accepted: true, duplicate: Number(ins.changes) === 0 };
  appendAudit(db, a.workspace_id, 'WEBHOOK_VERIFIED', { type: 'PROVIDER', id: 'paypal-sandbox' }, a.transaction_id, { event_type: event.event_type });
  await syncPayment(ctx, a.workspace_id, a.transaction_id).catch(() => {});
  return { accepted: true };
}
