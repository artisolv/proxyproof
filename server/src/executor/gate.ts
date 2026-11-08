import { one, run, tx, type DB } from '../db/index.js';
import { newId, nowIso, safeEqual } from '../core/util.js';
import { appendAudit, type Actor } from '../core/ledger.js';
import { paymentKey, transactionFingerprint } from '../core/tte.js';
import { evaluate } from '../policy/engine.js';
import { buildFacts, decisionSignature, type Ctx } from '../pipeline.js';
import { ProviderError, __issuePass, type GatePass, type PayPal } from './paypal.js';

export class GateRefused extends Error {
  status = 403;
  constructor(public code: string, message: string) { super(message); }
}

export type ExecutorCtx = Ctx & { paypal: PayPal; publicUrl: string };
type Caller = { workspaceId: string; actor: Actor; role?: string };

function refuse(db: DB, c: Caller, requestId: string, decisionId: string | undefined, code: string, message: string): never {
  run(db, `INSERT INTO gate_log (id, workspace_id, payment_request_id, decision_id, actor, outcome, reason_code, detail, created_at) VALUES (?,?,?,?,?, 'REFUSED', ?, ?, ?)`, newId('gat'), c.workspaceId, requestId, decisionId ?? null, `${c.actor.type}:${c.actor.id ?? ''}`, code, message, nowIso());
  if (one(db, 'SELECT 1 FROM workspaces WHERE id = ?', c.workspaceId) && one(db, 'SELECT 1 FROM payment_requests WHERE id = ? AND workspace_id = ?', requestId, c.workspaceId))
    appendAudit(db, c.workspaceId, 'EXECUTOR_REFUSED', c.actor, requestId, { code, decision_id: decisionId ?? null });
  throw new GateRefused(code, message);
}

/**
 * Every payment passes here, with no alternative route. The stored decision must be genuine, current, and ALLOW.
 * Then the engine runs again on live state, and the attempt is claimed atomically before a provider is contacted.
 * Returns a pass that the rail requires.
 */
export function authorizeExecution(ctx: ExecutorCtx, c: Caller, requestId: string, decisionId: string | undefined): { pass: GatePass; attempt: any; req: any } {
  const { db, decisionKey } = ctx;
  const req = one<any>(db, 'SELECT * FROM payment_requests WHERE id = ?', requestId);
  // Unknown and wrong-workspace requests look identical to the caller.
  if (!req || req.workspace_id !== c.workspaceId) refuse(db, c, requestId, decisionId, 'WRONG_WORKSPACE', 'This request does not exist in your workspace.');
  if (c.actor.type !== 'USER' || !['OWNER', 'FINANCE_ADMIN'].includes(c.role ?? '')) refuse(db, c, requestId, decisionId, 'ROLE_NOT_PERMITTED', 'Only an owner or finance admin can release a payment.');
  if (!decisionId) refuse(db, c, requestId, decisionId, 'NO_DECISION', 'A policy decision is required before payment.');
  const d = one<any>(db, 'SELECT * FROM policy_decisions WHERE id = ?', decisionId);
  if (!d || d.payment_request_id !== requestId || d.workspace_id !== c.workspaceId) refuse(db, c, requestId, decisionId, 'NO_DECISION', 'That decision does not belong to this request.');
  if (!safeEqual(d.signature, decisionSignature(decisionKey, d))) refuse(db, c, requestId, decisionId, 'DECISION_TAMPERED', 'The decision record failed its integrity check.');
  if (d.decision === 'DENY') refuse(db, c, requestId, decisionId, 'DECISION_DENIED', 'This request was denied.');
  if (d.decision === 'HOLD') refuse(db, c, requestId, decisionId, 'DECISION_HELD', 'This request is on hold.');
  if (d.decision === 'REVIEW') refuse(db, c, requestId, decisionId, 'APPROVAL_REQUIRED', 'This request needs human approval first.');
  if (d.superseded) refuse(db, c, requestId, decisionId, 'DECISION_SUPERSEDED', 'A newer decision replaced this one.');
  if (Date.parse(d.expires_at) <= Date.now()) refuse(db, c, requestId, decisionId, 'DECISION_EXPIRED', 'This decision expired. Evaluate the request again.');
  if (req.status !== 'READY_FOR_CONFIRMATION') refuse(db, c, requestId, decisionId, 'WRONG_STATE', `A request in state ${req.status} cannot be paid.`);

  try {
    return tx(db, () => {
      const { facts, tte, policy, invoice } = buildFacts(db, requestId);
      const fp = transactionFingerprint(tte);
      if (fp !== d.transaction_fingerprint) throw new GateRefused('TRANSACTION_CHANGED', 'The transaction changed after it was evaluated.');
      const fresh = evaluate(facts, policy.rules);
      if (fresh.decision !== 'ALLOW') throw new GateRefused('LIVE_RECHECK_FAILED', `A fresh check returned ${fresh.decision}: ${fresh.reasons.filter((r) => !fresh.satisfiedByApproval.includes(r.code)).map((r) => r.code).join(', ')}.`);
      const dest = one<any>(db, `SELECT * FROM vendor_destinations WHERE vendor_id = ? AND fingerprint = ? AND status = 'VERIFIED'`, req.vendor_id, req.destination_fingerprint);
      if (!dest || dest.type !== 'PAYPAL_EMAIL') throw new GateRefused('DESTINATION_NOT_PAYABLE', 'There is no verified PayPal destination for this payee.');
      const key = paymentKey({ workspaceId: req.workspace_id, vendorId: req.vendor_id, invoiceFingerprint: invoice?.semantic_fingerprint ?? null, requestId, amountMinor: req.amount_minor, currency: req.currency });
      const attemptId = newId('pay');
      const idem = `pp-${key.slice(0, 24)}-${attemptId.slice(4, 12)}`;
      const now = nowIso();
      try {
        run(db, `INSERT INTO payment_attempts (id, workspace_id, payment_request_id, decision_id, payment_key, transaction_fingerprint, rail, invoice_id, agent_id, status, provider, idempotency_key, vendor_id, amount_minor, currency, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?, 'CREATED', 'PAYPAL_SANDBOX', ?,?,?,?,?,?)`, attemptId, req.workspace_id, requestId, d.id, key, fp, req.rail, invoice?.id ?? null, req.agent_id ?? null, idem, req.vendor_id, req.amount_minor, req.currency, now, now);
      } catch (e: any) {
        if (String(e.message).includes('UNIQUE')) throw new GateRefused('DUPLICATE_EXECUTION', 'This payment was already released once.');
        throw e;
      }
      run(db, `UPDATE payment_requests SET status = 'EXECUTING', updated_at = ? WHERE id = ?`, now, requestId);
      run(db, `INSERT INTO gate_log (id, workspace_id, payment_request_id, decision_id, actor, outcome, reason_code, detail, created_at) VALUES (?,?,?,?,?, 'PASSED', 'ALL_CHECKS_PASSED', ?, ?)`, newId('gat'), req.workspace_id, requestId, d.id, `${c.actor.type}:${c.actor.id ?? ''}`, `Attempt ${attemptId}`, now);
      appendAudit(db, req.workspace_id, 'EXECUTION_REQUESTED', c.actor, requestId, { attempt_id: attemptId, decision_id: d.id, transaction_fingerprint: fp, rail: req.rail, amount_minor: req.amount_minor, currency: req.currency });
      const attempt = one<any>(db, 'SELECT * FROM payment_attempts WHERE id = ?', attemptId);
      return { pass: __issuePass({ attemptId, requestId }), attempt, req: { ...req, destination_value: dest.value } };
    });
  } catch (e) {
    if (e instanceof GateRefused) refuse(db, c, requestId, decisionId, e.code, e.message);
    throw e;
  }
}

const finalize = (db: DB, attempt: any, status: string, fields: { providerStatus?: string; providerRef?: string; itemRef?: string; failure?: string; confirmedBy?: string; approveUrl?: string }) => {
  // A confirmed payment can only move to refunded. Nothing un-pays it and frees its invoice for a second payment.
  const current = one<any>(db, 'SELECT status FROM payment_attempts WHERE id = ?', attempt.id)?.status;
  if (current === 'COMPLETED' && status !== 'COMPLETED' && status !== 'REFUNDED') return;
  run(db, `UPDATE payment_attempts SET status = ?, provider_status = COALESCE(?, provider_status), provider_ref = COALESCE(?, provider_ref), provider_item_ref = COALESCE(?, provider_item_ref), failure = COALESCE(?, failure), confirmed_by = COALESCE(?, confirmed_by), approve_url = COALESCE(?, approve_url), updated_at = ? WHERE id = ?`,
    status, fields.providerStatus ?? null, fields.providerRef ?? null, fields.itemRef ?? null, fields.failure ?? null, fields.confirmedBy ?? null, fields.approveUrl ?? null, nowIso(), attempt.id);
  const reqStatus = status === 'COMPLETED' || status === 'REFUNDED' ? 'COMPLETED' : status === 'FAILED' ? 'FAILED' : 'PAYMENT_PENDING';
  run(db, 'UPDATE payment_requests SET status = ?, updated_at = ? WHERE id = ?', reqStatus, nowIso(), attempt.payment_request_id);
};

/** Passes the gate, then calls the rail. Provider outcomes are recorded exactly as reported; nothing is assumed. */
export async function executePayment(ctx: ExecutorCtx, c: Caller, requestId: string, decisionId: string | undefined) {
  const { db, paypal, publicUrl } = ctx;
  const { pass, attempt, req } = authorizeExecution(ctx, c, requestId, decisionId);
  try {
    if (req.rail === 'ORDERS') {
      const r = await paypal.createOrder(pass, { idempotencyKey: attempt.idempotency_key, payeeEmail: req.destination_value, amountMinor: req.amount_minor, currency: req.currency, returnUrl: `${publicUrl}/paypal/return?request=${requestId}`, cancelUrl: `${publicUrl}/app/requests/${requestId}` });
      finalize(db, attempt, 'CREATED', { providerStatus: r.status, providerRef: r.orderId, approveUrl: r.approveUrl });
      appendAudit(db, req.workspace_id, 'PROVIDER_RESPONSE', { type: 'PROVIDER', id: 'paypal-sandbox' }, requestId, { rail: 'ORDERS', order_id: r.orderId, status: r.status });
      return { attemptId: attempt.id, status: 'CREATED', approveUrl: r.approveUrl, providerRef: r.orderId };
    }
    const r = await paypal.createPayout(pass, { idempotencyKey: attempt.idempotency_key, receiverEmail: req.destination_value, amountMinor: req.amount_minor, currency: req.currency, note: `Invoice payment ${requestId}` });
    finalize(db, attempt, 'CAPTURE_PENDING', { providerStatus: r.batchStatus, providerRef: r.batchId });
    appendAudit(db, req.workspace_id, 'PROVIDER_RESPONSE', { type: 'PROVIDER', id: 'paypal-sandbox' }, requestId, { rail: 'PAYOUTS', payout_batch_id: r.batchId, status: r.batchStatus });
    return { attemptId: attempt.id, status: 'CAPTURE_PENDING', providerRef: r.batchId };
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('The payment call failed unexpectedly.', 'AMBIGUOUS');
    const status = err.kind === 'DEFINITE' ? 'FAILED' : 'UNKNOWN';
    finalize(db, attempt, status, { failure: err.message });
    appendAudit(db, req.workspace_id, 'PROVIDER_ERROR', { type: 'PROVIDER', id: 'paypal-sandbox' }, requestId, { outcome: status, message: err.message.slice(0, 300) });
    return { attemptId: attempt.id, status, failure: err.message };
  }
}

const PAYOUT_ITEM_MAP: Record<string, string> = { SUCCESS: 'COMPLETED', FAILED: 'FAILED', RETURNED: 'FAILED', BLOCKED: 'FAILED', REFUNDED: 'REFUNDED', REVERSED: 'REFUNDED', DENIED: 'FAILED', CANCELED: 'FAILED', PENDING: 'CAPTURE_PENDING', UNCLAIMED: 'CAPTURE_PENDING', ONHOLD: 'CAPTURE_PENDING', NEW: 'CAPTURE_PENDING' };

/** Reads the provider's status through the authenticated API. This, or a verified webhook, is the only path to COMPLETED. */
export async function syncAttempt(ctx: ExecutorCtx, attemptId: string) {
  const { db, paypal } = ctx;
  const attempt = one<any>(db, 'SELECT * FROM payment_attempts WHERE id = ?', attemptId);
  if (!attempt || attempt.provider !== 'PAYPAL_SANDBOX' || !attempt.provider_ref) return attempt;
  if (['COMPLETED', 'FAILED', 'REFUNDED'].includes(attempt.status)) return attempt;
  if (attempt.rail === 'PAYOUTS') {
    const r = await paypal.getPayoutBatch(attempt.provider_ref);
    const next = r.itemStatus ? PAYOUT_ITEM_MAP[r.itemStatus] ?? 'CAPTURE_PENDING' : 'CAPTURE_PENDING';
    if (next !== attempt.status || r.itemStatus !== attempt.provider_status) {
      finalize(db, attempt, next, { providerStatus: r.itemStatus ?? r.batchStatus, itemRef: r.itemId, failure: r.error, confirmedBy: next === 'COMPLETED' ? 'Authenticated PayPal API lookup' : undefined });
      appendAudit(db, attempt.workspace_id, next === 'COMPLETED' ? 'PAYMENT_CONFIRMED' : 'PROVIDER_STATUS', { type: 'PROVIDER', id: 'paypal-sandbox' }, attempt.payment_request_id, { via: 'api_lookup', item_status: r.itemStatus, batch_status: r.batchStatus, status: next });
    }
  } else {
    const r = await paypal.getOrder(attempt.provider_ref);
    const next = r.captureStatus === 'COMPLETED' ? 'COMPLETED' : r.captureStatus === 'DECLINED' || r.captureStatus === 'FAILED' ? 'FAILED' : r.captureStatus === 'REFUNDED' ? 'REFUNDED' : r.status === 'APPROVED' ? 'APPROVED' : r.captureStatus ? 'CAPTURE_PENDING' : attempt.status;
    if (next !== attempt.status) {
      finalize(db, attempt, next, { providerStatus: r.captureStatus ?? r.status, itemRef: r.captureId, confirmedBy: next === 'COMPLETED' ? 'Authenticated PayPal API lookup' : undefined });
      appendAudit(db, attempt.workspace_id, next === 'COMPLETED' ? 'PAYMENT_CONFIRMED' : 'PROVIDER_STATUS', { type: 'PROVIDER', id: 'paypal-sandbox' }, attempt.payment_request_id, { via: 'api_lookup', order_status: r.status, capture_status: r.captureStatus, status: next });
    }
  }
  return one<any>(db, 'SELECT * FROM payment_attempts WHERE id = ?', attemptId);
}

/** Second half of the checkout rail. The buyer's redirect proves nothing; capture re-checks policy, then asks PayPal. */
export async function captureApprovedOrder(ctx: ExecutorCtx, c: Caller, requestId: string) {
  const { db, paypal } = ctx;
  const attempt = one<any>(db, `SELECT * FROM payment_attempts WHERE payment_request_id = ? AND rail = 'ORDERS' AND status <> 'FAILED' ORDER BY created_at DESC LIMIT 1`, requestId);
  if (!attempt || attempt.workspace_id !== c.workspaceId) refuse(db, c, requestId, undefined, 'NO_ATTEMPT', 'There is no checkout to complete for this request.');
  if (c.actor.type !== 'USER' || !['OWNER', 'FINANCE_ADMIN'].includes(c.role ?? '')) refuse(db, c, requestId, attempt.decision_id, 'ROLE_NOT_PERMITTED', 'Only an owner or finance admin can complete a payment.');
  if (!['CREATED', 'APPROVED'].includes(attempt.status)) refuse(db, c, requestId, attempt.decision_id, 'WRONG_STATE', 'This checkout is not waiting for capture.');
  const { facts, tte, policy } = buildFacts(db, requestId, { ownAttemptId: attempt.id });
  if (transactionFingerprint(tte) !== attempt.transaction_fingerprint) refuse(db, c, requestId, attempt.decision_id, 'TRANSACTION_CHANGED', 'The transaction changed after checkout started.');
  const fresh = evaluate(facts, policy.rules);
  if (fresh.decision !== 'ALLOW') refuse(db, c, requestId, attempt.decision_id, 'LIVE_RECHECK_FAILED', `A fresh check returned ${fresh.decision}.`);
  const pass = __issuePass({ attemptId: attempt.id, requestId });
  try {
    const r = await paypal.captureOrder(pass, attempt.provider_ref, attempt.idempotency_key);
    appendAudit(db, attempt.workspace_id, 'PROVIDER_RESPONSE', { type: 'PROVIDER', id: 'paypal-sandbox' }, requestId, { rail: 'ORDERS', status: r.status, capture_status: r.captureStatus });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('Capture failed unexpectedly.', 'AMBIGUOUS');
    if (err.kind === 'DEFINITE' && err.name_ !== 'UNPROCESSABLE_ENTITY') finalize(db, attempt, 'FAILED', { failure: err.message });
    appendAudit(db, attempt.workspace_id, 'PROVIDER_ERROR', { type: 'PROVIDER', id: 'paypal-sandbox' }, requestId, { message: err.message.slice(0, 300) });
  }
  return syncAttempt(ctx, attempt.id);
}

/** Authenticated webhook intake. Unverified events change nothing. Verified duplicates change nothing. */
export async function handleWebhook(ctx: ExecutorCtx, headers: Record<string, string | undefined>, rawBody: string, payloadHash: string) {
  const { db, paypal } = ctx;
  let event: any = null;
  try { event = JSON.parse(rawBody); } catch { /* handled below */ }
  const verified = event ? await paypal.verifyWebhook(headers, rawBody) : false;
  if (!verified) {
    run(db, `INSERT INTO provider_events (id, provider_event_id, event_type, verified, rejection, payload_sha256, received_at) VALUES (?,?,?,0,?,?,?)`, newId('evt'), event?.id?.toString().slice(0, 100) ?? null, event?.event_type?.toString().slice(0, 100) ?? null, 'Signature verification failed', payloadHash, nowIso());
    return { accepted: false as const };
  }
  const res = event.resource ?? {};
  const ref: string | undefined = res.batch_header?.payout_batch_id ?? res.payout_batch_id ?? res.supplementary_data?.related_ids?.order_id ?? (event.event_type?.startsWith('CHECKOUT.ORDER') ? res.id : undefined);
  const attempt = ref ? one<any>(db, 'SELECT * FROM payment_attempts WHERE provider_ref = ?', ref) : undefined;
  const ins = run(db, `INSERT OR IGNORE INTO provider_events (id, provider_event_id, event_type, verified, attempt_id, payload_sha256, received_at) VALUES (?,?,?,1,?,?,?)`, newId('evt'), event.id, event.event_type, attempt?.id ?? null, payloadHash, nowIso());
  if (Number(ins.changes) === 0) return { accepted: true as const, duplicate: true };
  if (!attempt) return { accepted: true as const, matched: false };
  appendAudit(db, attempt.workspace_id, 'WEBHOOK_VERIFIED', { type: 'PROVIDER', id: 'paypal-sandbox' }, attempt.payment_request_id, { event_id: event.id, event_type: event.event_type });
  const t: string = event.event_type;
  const terminal: string | null = t === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' || t === 'PAYMENT.CAPTURE.COMPLETED' ? 'COMPLETED'
    : /PAYOUTS-ITEM\.(FAILED|BLOCKED|DENIED|CANCELED|RETURNED)$|CAPTURE\.(DENIED|DECLINED)$/.test(t) ? 'FAILED'
    : /CAPTURE\.(REFUNDED|REVERSED)$|PAYOUTS-ITEM\.REFUNDED$/.test(t) ? 'REFUNDED' : null;
  if (terminal && attempt.status !== terminal) {
    finalize(db, attempt, terminal, { providerStatus: t, confirmedBy: 'Verified PayPal webhook', itemRef: res.payout_item_id ?? res.id });
    appendAudit(db, attempt.workspace_id, terminal === 'COMPLETED' ? 'PAYMENT_CONFIRMED' : 'PROVIDER_STATUS', { type: 'PROVIDER', id: 'paypal-sandbox' }, attempt.payment_request_id, { via: 'verified_webhook', event_id: event.id, status: terminal });
  } else if (terminal === 'COMPLETED') {
    run(db, `UPDATE payment_attempts SET confirmed_by = 'Authenticated PayPal API lookup and verified webhook' WHERE id = ?`, attempt.id);
  } else if (t === 'CHECKOUT.ORDER.APPROVED' && attempt.status === 'CREATED') {
    finalize(db, attempt, 'APPROVED', { providerStatus: 'APPROVED' });
  } else {
    await syncAttempt(ctx, attempt.id).catch(() => {});
  }
  return { accepted: true as const, matched: true };
}
