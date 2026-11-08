/**
 * Read models for the dashboard, the transaction list and the investigation summary.
 * Everything here is derived from stored records: the latest signed policy decision, its facts,
 * approvals and payment attempts. Nothing is keyed to scenario names, labels or file names,
 * and no state is invented. A payment is COMPLETED only when a sandbox attempt is COMPLETED.
 */
import { all, one, type DB } from '../db/index.js';
import type { Facts, Reason } from '../policy/engine.js';

/** What a person should read as the transaction's state. Distinct from the policy decision. */
export type Outcome = 'ALLOWED' | 'UNDER_REVIEW' | 'HELD' | 'DENIED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'NOT_EVALUATED';
export type Check = { key: string; label: string; state: 'pass' | 'fail' | 'warn' | 'na'; detail: string };
export type Indicator = { key: string; label: string };
export type Activity = {
  id: string; reference: string | null; payee: string; vendorId: string | null; vendorStatus: string | null;
  amount_minor: number | null; currency: string | null; initiator: { kind: 'AGENT' | 'HUMAN'; name: string };
  outcome: Outcome; decision: string | null; status: string; reason: string; moreReasons: number;
  reasonCodes: string[]; indicators: Indicator[]; nextAction: string | null; created_at: string; updated_at: string;
  executorCalled: boolean; providerRef: string | null; sample: boolean;
};

const EFFECT_RANK: Record<string, number> = { ALLOW: 0, REVIEW: 1, HOLD: 2, DENY: 3 };
const SEV_RANK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const J = (s: any, d: any = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const money = (minor: number | null | undefined, cur = 'USD') => minor == null ? 'an unknown amount' : new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(cur) ? cur : 'USD' }).format(minor / 100);

/** Risk families, keyed by reason code prefix or exact code. Order is display order. */
const FAMILIES: [string, string, (code: string) => boolean][] = [
  ['destination', 'New or unverified destination', (c) => c.startsWith('DESTINATION_')],
  ['agent', 'Agent authorization', (c) => c.startsWith('AGENT_') || c.startsWith('AUTH_')],
  ['duplicate', 'Duplicate or replay', (c) => c.startsWith('DUPLICATE_') || ['ALREADY_PAID', 'PAYMENT_IN_FLIGHT', 'POSSIBLE_REPEAT_PAYMENT'].includes(c)],
  ['invoice', 'Invoice inconsistency', (c) => ['TOTALS_INCONSISTENT', 'EXTRACTION_CONFLICT', 'AMOUNT_DIFFERS_FROM_INVOICE', 'CRITICAL_FIELD_UNKNOWN', 'FILE_REJECTED', 'MODEL_ONLY_FIELDS', 'PURCHASE_ORDER_MISSING', 'AMOUNT_INVALID'].includes(c)],
  ['sender', 'Sender or domain mismatch', (c) => c.startsWith('SENDER_') || ['REPLY_TO_MISMATCH', 'VENDOR_NAME_RESEMBLES', 'VENDOR_NAME_MISMATCH'].includes(c)],
  ['injection', 'Instructions aimed at software', (c) => ['EMBEDDED_INSTRUCTIONS', 'WEBSITE_INSTRUCTIONS', 'MODEL_RAISED_CONCERN', 'URGENCY_LANGUAGE'].includes(c)],
  ['vendor', 'Unverified or restricted payee', (c) => c.startsWith('VENDOR_')],
  ['amount', 'Amount outside normal limits', (c) => ['HARD_LIMIT_EXCEEDED', 'APPROVAL_THRESHOLD', 'AMOUNT_UNUSUAL', 'CURRENCY_NOT_ALLOWED'].includes(c)],
  ['process', 'Verification or approval state', () => true],
];
export const FAMILY_LABEL: Record<string, string> = Object.fromEntries(FAMILIES.map(([k, l]) => [k, l]));
export const familyOf = (code: string) => FAMILIES.find(([, , m]) => m(code))![0];

export function outcomeOf(status: string, decision: string | null, attemptStatus: string | null): Outcome {
  if (attemptStatus === 'COMPLETED' || status === 'COMPLETED') return 'COMPLETED';
  if (status === 'FAILED' || attemptStatus === 'FAILED') return 'FAILED';
  if (attemptStatus || ['EXECUTING', 'PAYMENT_PENDING'].includes(status)) return 'PROCESSING';
  if (status === 'REJECTED' || decision === 'DENY') return 'DENIED';
  if (decision === 'HOLD') return 'HELD';
  if (decision === 'REVIEW') return 'UNDER_REVIEW';
  if (decision === 'ALLOW') return 'ALLOWED';
  return 'NOT_EVALUATED';
}

/** Plain statements of what was checked, from the facts the policy engine evaluated. */
export function checksFrom(f: Facts | null, reasons: Reason[], ctx: { vendorName?: string | null; submitter?: string | null; agentName?: string | null }): Check[] {
  if (!f) return [];
  const codes = new Set(reasons.map((r) => r.code));
  const out: Check[] = [];
  const v = f.vendor;
  out.push({ key: 'vendor', label: 'Payee identity', ...(v.status === 'VERIFIED' && !v.nameMismatch && !v.resembles
    ? { state: 'pass', detail: `${ctx.vendorName ?? 'The vendor'} is a verified business in your directory.` }
    : v.status === 'UNKNOWN' ? { state: 'fail', detail: v.resembles ? `Not in your directory. The name resembles ${v.resembles}.` : 'Not in your trusted directory. Web presence does not count as verification.' }
    : v.resembles ? { state: 'fail', detail: `The name resembles ${v.resembles}, a different verified vendor.` }
    : v.nameMismatch ? { state: 'fail', detail: 'The name on the invoice does not match the vendor record.' }
    : { state: 'fail', detail: `The vendor is ${v.status.toLowerCase()}.` }) } as Check);
  const d = f.destination;
  out.push({ key: 'destination', label: 'Payment destination', ...(d.status === 'MATCH'
    ? { state: 'pass', detail: 'Matches a destination verified independently for this vendor.' }
    : d.status === 'MISMATCH' ? { state: 'fail', detail: 'Differs from the destination verified for this vendor.' }
    : d.status === 'MISSING' ? { state: 'fail', detail: 'No payment destination was stated.' }
    : { state: 'fail', detail: 'There is no verified destination on file to compare with.' }) } as Check);
  const x = f.extraction;
  out.push({ key: 'invoice', label: 'Invoice integrity', ...(x.maliciousFile ? { state: 'fail', detail: 'The file was rejected as unsafe or unreadable.' }
    : x.totals === 'CONFLICT' ? { state: 'fail', detail: 'The printed total does not equal the line items plus tax.' }
    : x.amountDiffersFromInvoice ? { state: 'fail', detail: 'The requested amount differs from the invoice total.' }
    : x.conflicts.length ? { state: 'fail', detail: `Sources disagree on: ${x.conflicts.join(', ')}.` }
    : x.criticalUnknown.length ? { state: 'fail', detail: `Could not read: ${x.criticalUnknown.join(', ')}.` }
    : x.totals === 'CONSISTENT' ? { state: 'pass', detail: 'Totals add up and every critical field was read.' }
    : { state: 'na', detail: 'No invoice file was supplied.' }) } as Check);
  const dup = f.duplicates;
  const dupHits = [dup.alreadyPaid && 'already paid', dup.paymentInFlight && 'payment in flight', dup.exactFile && 'identical file', dup.sameNumber && 'same invoice number', dup.semantic && 'same content', dup.repeatWithoutInvoice && 'same vendor and amount paid recently'].filter(Boolean);
  out.push({ key: 'duplicate', label: 'Duplicate and replay', ...(dupHits.length ? { state: 'fail', detail: `Matches an earlier request: ${dupHits.join(', ')}.` } : { state: 'pass', detail: 'No earlier request or payment matches this one.' }) } as Check);
  if (f.origin === 'AGENT' && f.agent) {
    const a = f.agent;
    const misses = [!a.registered && 'agent not registered', !a.active && 'agent revoked', a.signature !== 'VALID' && `signature ${a.signature.toLowerCase()}`, a.grant !== 'VALID' && `authorization ${a.grant.toLowerCase().replace('_', ' ')}`, a.replayedNonce && 'request replayed',
      a.grant === 'VALID' && !a.vendorInScope && 'vendor outside scope', a.grant === 'VALID' && !a.amountInScope && 'amount above its per-payment limit', a.grant === 'VALID' && !a.categoryInScope && 'category outside scope', a.grant === 'VALID' && !a.currencyInScope && 'currency outside scope',
      a.grant === 'VALID' && !a.dailyBudgetOk && 'daily budget exceeded', a.grant === 'VALID' && !a.monthlyBudgetOk && 'monthly budget exceeded'].filter(Boolean);
    out.push({ key: 'authority', label: 'Agent authorization', ...(misses.length ? { state: 'fail', detail: `${ctx.agentName ?? 'The agent'}: ${misses.join(', ')}.` } : { state: 'pass', detail: `${ctx.agentName ?? 'The agent'} signed with its registered key and stayed within its authorization.` }) } as Check);
  } else out.push({ key: 'authority', label: 'Requester', state: 'pass', detail: `Submitted by ${ctx.submitter ?? 'a signed-in team member'}. Separation of duties applies to approvals.` });
  const s = f.sender;
  if (s.present) {
    const bad = [s.domain === 'LOOKALIKE' && 'the domain imitates the vendor', s.domain === 'UNRECOGNIZED' && 'the domain is not on record for this vendor', s.replyTo === 'MISMATCH' && 'replies go to a different address', s.authFailed && 'email authentication failed'].filter(Boolean);
    out.push({ key: 'sender', label: 'Sender', ...(bad.length ? { state: 'fail', detail: `Email: ${bad.join(', ')}.` } : { state: 'pass', detail: 'Sent from a domain on record for this vendor.' }) } as Check);
  }
  const inj = f.signals.injection + f.signals.websiteInjection;
  out.push({ key: 'instructions', label: 'Embedded instructions', ...(inj > 0 ? { state: 'warn', detail: `${inj} instruction${inj > 1 ? 's' : ''} aimed at software found. Ignored, and treated as a warning sign.` } : { state: 'pass', detail: 'No instructions aimed at software were found.' }) } as Check);
  out.push({ key: 'amount', label: 'Amount and limits', ...(codes.has('HARD_LIMIT_EXCEEDED') ? { state: 'fail', detail: 'Above the workspace hard limit.' }
    : codes.has('APPROVAL_THRESHOLD') ? { state: 'warn', detail: 'Above the amount that needs a person’s approval.' }
    : codes.has('AMOUNT_UNUSUAL') ? { state: 'warn', detail: 'Far larger than this vendor’s paid history.' }
    : codes.has('CURRENCY_NOT_ALLOWED') ? { state: 'fail', detail: 'The currency is not allowed by policy.' }
    : f.amount.minor == null ? { state: 'fail', detail: 'The amount is unknown.' } : { state: 'pass', detail: 'Within policy limits and consistent with paid history.' }) } as Check);
  return out;
}

const NEXT: Record<string, string> = {
  destination: 'Confirm the new destination with the vendor on a channel you already trust',
  vendor: 'Verify the payee’s identity before adding them',
  duplicate: 'Compare with the earlier request; do not pay twice',
  invoice: 'Ask the vendor for a corrected invoice',
  sender: 'Do not reply. Contact the vendor at their known address',
  injection: 'Read the flagged text, then approve or reject',
  amount: 'A person must approve this amount',
};

export function nextActionFor(outcome: Outcome, top: Reason | undefined): string | null {
  switch (outcome) {
    case 'ALLOWED': return 'Release the payment';
    case 'PROCESSING': return 'Waiting for PayPal to confirm';
    case 'FAILED': return 'Check the provider error and try again';
    case 'COMPLETED': case 'NOT_EVALUATED': return null;
    case 'UNDER_REVIEW': return top ? NEXT[familyOf(top.code)] ?? 'Review the evidence, then approve or reject' : 'Review the evidence, then approve or reject';
    case 'HELD': return top ? NEXT[familyOf(top.code)] ?? 'Resolve the hold, then evaluate again' : 'Resolve the hold, then evaluate again';
    case 'DENIED': return top && familyOf(top.code) === 'agent' ? 'None. Change the agent’s authorization if this was intended' : 'None. This request cannot be paid';
  }
}

/** One line a person can read: why this transaction is where it is. */
function reasonLine(o: Outcome, active: Reason[], f: Facts | null, extra: { approver?: string | null; rejectComment?: string | null; confirmedBy?: string | null; failure?: string | null; agentName?: string | null; submitter?: string | null; approvedCodes: string[] }) {
  if (o === 'COMPLETED') return `Payment confirmed by PayPal${extra.confirmedBy ? ` (${extra.confirmedBy.replace(/^Authenticated PayPal API lookup.*/i, 'authenticated API lookup').replace(/^Verified PayPal webhook.*/i, 'verified webhook')})` : ''}.`;
  if (o === 'PROCESSING') return 'Released through the payment gate. PayPal has not confirmed it yet.';
  if (o === 'FAILED') return `PayPal did not complete the payment${extra.failure ? `: ${extra.failure}` : '.'}`;
  if (o === 'NOT_EVALUATED') return 'Not evaluated yet.';
  if (extra.rejectComment !== undefined && extra.rejectComment !== null && o === 'DENIED' && !active.length) return `Rejected by ${extra.approver ?? 'a reviewer'}${extra.rejectComment ? `: ${extra.rejectComment}` : '.'}`;
  if (active.length) return active[0].message;
  // ALLOWED: say what was verified, from the facts.
  const parts: string[] = [];
  if (f?.vendor.status === 'VERIFIED') parts.push('Verified vendor');
  if (f?.destination.status === 'MATCH') parts.push('matching verified destination');
  if (f?.origin === 'AGENT') parts.push(`${extra.agentName ?? 'agent'} within its authorization`);
  if (f && !Object.values(f.duplicates).some(Boolean)) parts.push('no duplicate');
  if (extra.approvedCodes.length) parts.push(`approved by ${extra.approver ?? 'a reviewer'}`);
  const s = parts.join(', ');
  return s ? `${s[0].toUpperCase()}${s.slice(1)}.` : 'Every check passed.';
}

export function describeRequest(db: DB, r: any): Activity & { checks: Check[] } {
  const d = one<any>(db, 'SELECT * FROM policy_decisions WHERE payment_request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', r.id);
  const reasonsDoc = d ? J(d.reasons, {}) : {};
  const reasons: Reason[] = reasonsDoc.reasons ?? [];
  const satisfied: string[] = reasonsDoc.satisfiedByApproval ?? [];
  // Strictest effect first, then most severe, so the headline reason is the one that matters most.
  const active = reasons.filter((x) => !satisfied.includes(x.code)).sort((a, b) => EFFECT_RANK[b.effect] - EFFECT_RANK[a.effect] || SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  const facts: Facts | null = d ? J(d.facts) : null;
  const attempt = one<any>(db, `SELECT status, provider_ref, confirmed_by, failure FROM payment_attempts WHERE payment_request_id = ? AND provider = 'PAYPAL_SANDBOX' ORDER BY created_at DESC LIMIT 1`, r.id);
  const lastApproval = one<any>(db, 'SELECT a.action, a.comment, u.name FROM approvals a JOIN users u ON u.id = a.approver_user_id WHERE a.payment_request_id = ? AND a.invalidated_at IS NULL ORDER BY a.created_at DESC LIMIT 1', r.id);
  const vendor = r.vendor_id ? one<any>(db, 'SELECT name, status FROM vendors WHERE id = ?', r.vendor_id) : null;
  const invoice = r.invoice_id ? one<any>(db, 'SELECT number FROM invoices WHERE id = ?', r.invoice_id) : null;
  const agentName = r.agent_id ? one<any>(db, 'SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? null : null;
  const submitter = r.submitted_by ? one<any>(db, 'SELECT name FROM users WHERE id = ?', r.submitted_by)?.name ?? null : null;
  const outcome = outcomeOf(r.status, d?.decision ?? null, attempt?.status ?? null);
  const codes = active.map((x) => x.code);
  const fams = [...new Set(codes.map(familyOf))].filter((k) => k !== 'process' || codes.every((c) => familyOf(c) === 'process'));
  const reason = reasonLine(outcome, active, facts, { approver: lastApproval?.name, rejectComment: lastApproval?.action === 'REJECT' ? lastApproval.comment ?? '' : null, confirmedBy: attempt?.confirmed_by, failure: attempt?.failure, agentName, submitter, approvedCodes: satisfied });
  return {
    id: r.id, reference: invoice?.number ?? null, payee: vendor?.name ?? r.payee_name ?? 'Unknown payee', vendorId: r.vendor_id ?? null, vendorStatus: vendor?.status ?? null,
    amount_minor: r.amount_minor, currency: r.currency,
    initiator: r.origin === 'AGENT' ? { kind: 'AGENT', name: agentName ?? (r.claimed_agent_id ? 'Unregistered agent' : 'Unknown agent') } : { kind: 'HUMAN', name: submitter ?? 'Team member' },
    outcome, decision: d?.decision ?? null, status: r.status, reason, moreReasons: Math.max(0, active.length - 1), reasonCodes: codes,
    indicators: ['ALLOWED', 'COMPLETED', 'PROCESSING'].includes(outcome) ? [] : fams.map((k) => ({ key: k, label: FAMILY_LABEL[k] })),
    nextAction: nextActionFor(outcome, active[0]), created_at: r.created_at, updated_at: r.updated_at,
    executorCalled: Boolean(attempt), providerRef: attempt?.provider_ref ?? null, sample: r.label === 'sample',
    checks: checksFrom(facts, active, { vendorName: vendor?.name, submitter, agentName }),
  };
}

export function listActivity(db: DB, ws: string, limitN = 200) {
  return all<any>(db, 'SELECT * FROM payment_requests WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', ws, limitN).map((r) => {
    const { checks: _c, ...a } = describeRequest(db, r);
    return a;
  });
}

const sum = (rows: Activity[]) => rows.filter((r) => r.currency === 'USD' || r.currency == null).reduce((s, r) => s + (r.amount_minor ?? 0), 0);

export function dashboard(db: DB, ws: string) {
  const activity = listActivity(db, ws);
  const by = (o: Outcome) => activity.filter((a) => a.outcome === o);
  const ws_ = one<any>(db, 'SELECT created_at FROM workspaces WHERE id = ?', ws);
  const paidMinor = one<any>(db, `SELECT COALESCE(SUM(amount_minor),0) s FROM payment_attempts WHERE workspace_id = ? AND provider = 'PAYPAL_SANDBOX' AND status = 'COMPLETED' AND currency = 'USD'`, ws).s;
  const counts = Object.fromEntries((['ALLOWED', 'UNDER_REVIEW', 'HELD', 'DENIED', 'PROCESSING', 'COMPLETED', 'FAILED'] as Outcome[]).map((o) => [o, by(o).length]));
  // Ever allowed by policy: still waiting, released, or paid. Lets the dashboard separate "allowed" from "paid".
  const passedPolicy = counts.ALLOWED + counts.PROCESSING + counts.COMPLETED + counts.FAILED;

  // Insights: count each risk family across transactions that are currently stopped.
  const stopped = activity.filter((a) => ['UNDER_REVIEW', 'HELD', 'DENIED'].includes(a.outcome));
  const insights = FAMILIES.map(([key, label]) => ({ key, label, count: stopped.filter((a) => a.indicators.some((i) => i.key === key)).length, amountMinor: sum(stopped.filter((a) => a.indicators.some((i) => i.key === key))) }))
    .filter((i) => i.count > 0 && i.key !== 'process');

  // Payees: business identity and payment destinations are tracked separately.
  const vendors = all<any>(db, 'SELECT id, name, status, created_at FROM vendors WHERE workspace_id = ? ORDER BY name', ws);
  const dests = all<any>(db, `SELECT d.vendor_id, d.type, d.value, d.status, d.verified_at, d.verification_method, v.name AS vendor FROM vendor_destinations d JOIN vendors v ON v.id = d.vendor_id WHERE d.workspace_id = ?`, ws);
  const destChanges = activity.filter((a) => a.reasonCodes.includes('DESTINATION_MISMATCH') && a.outcome !== 'COMPLETED').map((a) => {
    const r = one<any>(db, 'SELECT destination_type, destination_value FROM payment_requests WHERE id = ?', a.id);
    return { requestId: a.id, payee: a.payee, requested: r?.destination_value ?? null, onFile: dests.filter((d) => d.vendor_id === a.vendorId && d.status === 'VERIFIED').map((d) => d.value), outcome: a.outcome };
  });
  const unknownPayees = [...new Map(activity.filter((a) => a.reasonCodes.includes('VENDOR_UNKNOWN') || a.reasonCodes.includes('VENDOR_PENDING')).map((a) => [a.payee, { payee: a.payee, requestId: a.id, outcome: a.outcome }])).values()];
  const recentDest = dests.filter((d) => d.status === 'VERIFIED' && ws_ && d.verified_at && Date.parse(d.verified_at) - Date.parse(ws_.created_at) > 60_000);
  const payees = {
    verified: vendors.filter((v) => v.status === 'VERIFIED').length,
    pending: vendors.filter((v) => v.status === 'PENDING').length,
    restricted: vendors.filter((v) => ['SUSPENDED', 'REVOKED'].includes(v.status)).length,
    verifiedDestinations: dests.filter((d) => d.status === 'VERIFIED').length,
    destChanges, unknownPayees,
    recentDestinations: recentDest.map((d) => ({ payee: d.vendor, type: d.type, value: d.value, verifiedAt: d.verified_at, method: d.verification_method })),
    list: vendors.map((v) => ({ id: v.id, name: v.name, status: v.status, destinations: dests.filter((d) => d.vendor_id === v.id && d.status === 'VERIFIED').length })),
  };
  const gate = Object.fromEntries(all<any>(db, 'SELECT outcome, COUNT(*) c FROM gate_log WHERE workspace_id = ? GROUP BY outcome', ws).map((r) => [r.outcome, r.c]));
  return {
    total: activity.length, counts, passedPolicy,
    amounts: { stoppedMinor: sum([...by('HELD'), ...by('DENIED')]), reviewMinor: sum(by('UNDER_REVIEW')), awaitingReleaseMinor: sum(by('ALLOWED')), paidMinor },
    activity: activity.slice(0, 10), insights, payees, gate: { passed: gate.PASSED ?? 0, refused: gate.REFUSED ?? 0 },
    agents: all<any>(db, `SELECT a.id, a.name, a.status, (SELECT COUNT(*) FROM payment_requests r WHERE r.agent_id = a.id) AS requests,
      (SELECT COUNT(*) FROM payment_requests r WHERE r.agent_id = a.id AND (SELECT decision FROM policy_decisions d WHERE d.payment_request_id = r.id ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) = 'DENY') AS denied
      FROM agents a WHERE a.workspace_id = ?`, ws),
    unregisteredAgentRequests: one<any>(db, `SELECT COUNT(*) c FROM payment_requests WHERE workspace_id = ? AND origin = 'AGENT' AND agent_id IS NULL`, ws).c,
  };
}
