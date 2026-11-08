/**
 * Deterministic policy engine. Pure functions over typed facts: no I/O, clock reads, randomness or model calls.
 * It is the only authority on whether a transaction may proceed. Model output reaches it only as
 * `signals.modelFindings`, which can raise a decision to REVIEW and can never lower one.
 */
export type Decision = 'ALLOW' | 'REVIEW' | 'HOLD' | 'DENY';
const RANK: Record<Decision, number> = { ALLOW: 0, REVIEW: 1, HOLD: 2, DENY: 3 };

export type PolicyRules = {
  hardLimitMinor: number;
  approvalThresholdMinor: number;
  allowedCurrencies: string[];
  unusualAmountMultiple: number; // Multiple of the vendor's largest historical amount. 0 turns the check off.
  requirePurchaseOrder: boolean;
  newVendorAction: 'HOLD' | 'REVIEW';
  lookalikeAction: 'HOLD' | 'DENY';
  urgencyAction: 'REVIEW' | 'IGNORE';
  injectionAction: 'REVIEW' | 'HOLD';
  requireEvidenceService: boolean;
  separationOfDuties: boolean;
  decisionTtlMinutes: number;
};
export const DEFAULT_RULES: PolicyRules = {
  hardLimitMinor: 2_500_000, approvalThresholdMinor: 500_000, allowedCurrencies: ['USD'], unusualAmountMultiple: 3,
  requirePurchaseOrder: false, newVendorAction: 'HOLD', lookalikeAction: 'HOLD', urgencyAction: 'REVIEW', injectionAction: 'REVIEW',
  requireEvidenceService: true, separationOfDuties: true, decisionTtlMinutes: 60,
};

export type AgentFacts = {
  registered: boolean; active: boolean;
  signature: 'VALID' | 'INVALID' | 'MISSING' | 'STALE';
  grant: 'VALID' | 'MISSING' | 'FORGED' | 'EXPIRED' | 'REVOKED' | 'SUPERSEDED' | 'WRONG_AGENT' | 'WRONG_WORKSPACE';
  replayedNonce: boolean;
  amountInScope: boolean; categoryInScope: boolean; vendorInScope: boolean; currencyInScope: boolean; actionInScope: boolean;
  dailyBudgetOk: boolean; monthlyBudgetOk: boolean; grantPolicyVersionCurrent: boolean;
};
export type Facts = {
  origin: 'HUMAN' | 'AGENT';
  agent: AgentFacts | null;
  vendor: { status: 'VERIFIED' | 'PENDING' | 'SUSPENDED' | 'REVOKED' | 'UNKNOWN'; currencyApproved: boolean; categoryApproved: boolean; nameMismatch: boolean; resembles: string | null };
  destination: { status: 'MATCH' | 'MISMATCH' | 'MISSING' | 'NO_TRUSTED_RECORD'; railSupported: boolean };
  sender: { present: boolean; domain: 'TRUSTED' | 'LOOKALIKE' | 'UNRECOGNIZED' | 'NONE'; replyTo: 'MATCH' | 'MISMATCH' | 'NONE'; authFailed: boolean };
  extraction: { criticalUnknown: string[]; conflicts: string[]; totals: 'CONSISTENT' | 'CONFLICT' | 'UNKNOWN'; maliciousFile: boolean; modelOnly: string[]; amountDiffersFromInvoice: boolean };
  duplicates: { alreadyPaid: boolean; paymentInFlight: boolean; exactFile: boolean; sameNumber: boolean; semantic: boolean; repeatWithoutInvoice: boolean };
  amount: { minor: number | null; currency: string | null; maxHistoricalMinor: number | null; purchaseOrderPresent: boolean };
  signals: { injection: number; urgency: number; modelFindings: number; websiteInjection: number };
  evidence: { registryAvailable: boolean; unavailable: string[] };
  approval: { valid: boolean; stale: boolean; rejected: boolean; reviewedCodes: string[] };
  lifecycle: { expired: boolean };
};

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type Reason = {
  code: string; effect: Decision; severity: Severity; message: string;
  /** Whether a recorded human approval can satisfy this reason. HOLD and DENY never can. */
  approvable: boolean;
};
export type Evaluation = { decision: Decision; reasons: Reason[]; satisfiedByApproval: string[]; rulesChecked: number };

type Rule = (f: Facts, p: PolicyRules) => Omit<Reason, 'approvable'> | null;
const fire = (code: string, effect: Decision, severity: Severity, message: string) => ({ code, effect, severity, message });
const money = (minor: number) => `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const rules: Rule[] = [
  // Agent identity and delegated authority.
  (f) => f.agent && !f.agent.registered ? fire('AGENT_NOT_REGISTERED', 'DENY', 'CRITICAL', 'The requesting agent is not registered in this workspace.') : null,
  (f) => f.agent && f.agent.registered && !f.agent.active ? fire('AGENT_REVOKED', 'DENY', 'CRITICAL', 'The requesting agent has been revoked.') : null,
  (f) => f.agent && f.agent.registered && f.agent.signature !== 'VALID' ? fire('AGENT_SIGNATURE_INVALID', 'DENY', 'CRITICAL', `The request signature is ${f.agent.signature.toLowerCase()}, so its origin cannot be proven.`) : null,
  (f) => f.agent?.replayedNonce ? fire('AGENT_REPLAY', 'DENY', 'CRITICAL', 'This signed agent request was already used. Replays are refused.') : null,
  (f) => f.agent && f.agent.grant === 'MISSING' ? fire('AUTH_MISSING', 'DENY', 'CRITICAL', 'The agent presented no authorization.') : null,
  (f) => f.agent && ['FORGED', 'WRONG_AGENT', 'WRONG_WORKSPACE'].includes(f.agent.grant) ? fire('AUTH_FORGED', 'DENY', 'CRITICAL', 'The authorization was not issued to this agent by this workspace.') : null,
  (f) => f.agent?.grant === 'EXPIRED' ? fire('AUTH_EXPIRED', 'DENY', 'CRITICAL', 'The agent’s authorization has expired.') : null,
  (f) => f.agent && ['REVOKED', 'SUPERSEDED'].includes(f.agent.grant) ? fire('AUTH_REVOKED', 'DENY', 'CRITICAL', 'The agent’s authorization was revoked or replaced.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.actionInScope ? fire('AUTH_ACTION_OUT_OF_SCOPE', 'DENY', 'HIGH', 'The authorization does not permit this action.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.amountInScope ? fire('AUTH_AMOUNT_EXCEEDED', 'DENY', 'HIGH', 'The amount is above the agent’s per-transaction limit.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.vendorInScope ? fire('AUTH_VENDOR_OUT_OF_SCOPE', 'DENY', 'HIGH', 'The agent is not authorized to pay this payee.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.categoryInScope ? fire('AUTH_CATEGORY_OUT_OF_SCOPE', 'DENY', 'HIGH', 'The agent is not authorized for this spending category.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.currencyInScope ? fire('AUTH_CURRENCY_OUT_OF_SCOPE', 'DENY', 'HIGH', 'The agent is not authorized for this currency.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.dailyBudgetOk ? fire('AUTH_DAILY_BUDGET_EXCEEDED', 'DENY', 'HIGH', 'This payment would exceed the agent’s daily budget.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.monthlyBudgetOk ? fire('AUTH_MONTHLY_BUDGET_EXCEEDED', 'DENY', 'HIGH', 'This payment would exceed the agent’s monthly budget.') : null,
  (f) => f.agent?.grant === 'VALID' && !f.agent.grantPolicyVersionCurrent ? fire('AUTH_POLICY_VERSION_CHANGED', 'HOLD', 'MEDIUM', 'The policy changed after this authorization was issued. Issue a new authorization to continue.') : null,

  // Replay and duplicates.
  (f) => f.duplicates.alreadyPaid ? fire('ALREADY_PAID', 'DENY', 'CRITICAL', 'This invoice has already been paid. A second payment is refused.') : null,
  (f) => f.duplicates.paymentInFlight ? fire('PAYMENT_IN_FLIGHT', 'HOLD', 'CRITICAL', 'A payment for this invoice is already in progress.') : null,
  (f) => f.duplicates.exactFile ? fire('DUPLICATE_FILE', 'HOLD', 'HIGH', 'This exact document was already submitted.') : null,
  (f) => f.duplicates.sameNumber ? fire('DUPLICATE_INVOICE_NUMBER', 'HOLD', 'HIGH', 'This vendor already submitted an invoice with this number.') : null,
  (f) => f.duplicates.repeatWithoutInvoice ? fire('POSSIBLE_REPEAT_PAYMENT', 'HOLD', 'HIGH', 'The same amount was recently paid, or is being paid, to this vendor and there is no invoice to tell them apart.') : null,
  (f) => f.duplicates.semantic ? fire('DUPLICATE_CONTENT', 'HOLD', 'HIGH', 'The contents match an earlier invoice even though the file differs.') : null,

  // Payee and destination.
  (f) => f.vendor.status === 'REVOKED' ? fire('VENDOR_REVOKED', 'DENY', 'CRITICAL', 'This vendor has been revoked.') : null,
  (f) => f.vendor.status === 'SUSPENDED' ? fire('VENDOR_SUSPENDED', 'HOLD', 'HIGH', 'This vendor is suspended.') : null,
  (f, p) => f.vendor.status === 'UNKNOWN' ? fire('VENDOR_UNKNOWN', p.newVendorAction, 'HIGH', 'This vendor is not in your trusted directory. Web presence does not count as verification.') : null,
  (f, p) => f.vendor.status === 'PENDING' ? fire('VENDOR_PENDING', p.newVendorAction, 'HIGH', 'This vendor has not finished verification.') : null,
  (f) => f.vendor.nameMismatch ? fire('VENDOR_NAME_MISMATCH', 'HOLD', 'HIGH', 'The name on the invoice does not match the selected vendor.') : null,
  (f) => f.vendor.resembles ? fire('VENDOR_NAME_RESEMBLES', 'HOLD', 'HIGH', `The vendor name closely resembles ${f.vendor.resembles} but is not the same.`) : null,
  (f) => f.destination.status === 'MISMATCH' ? fire('DESTINATION_MISMATCH', 'HOLD', 'CRITICAL', 'The payment destination does not match any verified destination for this vendor.') : null,
  (f) => f.destination.status === 'MISSING' ? fire('DESTINATION_MISSING', 'HOLD', 'HIGH', 'No payment destination could be established.') : null,
  (f) => f.destination.status === 'NO_TRUSTED_RECORD' ? fire('DESTINATION_UNVERIFIED', 'HOLD', 'HIGH', 'This destination has not been verified through an independent channel.') : null,
  (f) => f.destination.status === 'MATCH' && !f.destination.railSupported ? fire('RAIL_UNSUPPORTED', 'HOLD', 'LOW', 'The destination is verified, but the PayPal sandbox can only pay PayPal accounts.') : null,

  // Sender.
  (f, p) => f.sender.domain === 'LOOKALIKE' ? fire('SENDER_LOOKALIKE_DOMAIN', p.lookalikeAction, 'CRITICAL', 'The sender’s domain imitates this vendor’s verified domain.') : null,
  (f) => f.sender.replyTo === 'MISMATCH' ? fire('REPLY_TO_MISMATCH', 'HOLD', 'HIGH', 'Replies would go to a different domain than the sender’s.') : null,
  (f) => f.sender.domain === 'UNRECOGNIZED' && f.vendor.status === 'VERIFIED' ? fire('SENDER_DOMAIN_UNRECOGNIZED', 'HOLD', 'HIGH', 'The email did not come from a verified domain for this vendor.') : null,
  (f) => f.sender.authFailed ? fire('SENDER_AUTH_FAILED', 'HOLD', 'HIGH', 'The email failed sender authentication (SPF, DKIM or DMARC).') : null,

  // Document integrity.
  (f) => f.extraction.maliciousFile ? fire('FILE_REJECTED', 'HOLD', 'HIGH', 'The file could not be processed safely.') : null,
  (f) => f.extraction.criticalUnknown.length ? fire('CRITICAL_FIELD_UNKNOWN', 'HOLD', 'HIGH', `Required fields could not be established: ${f.extraction.criticalUnknown.join(', ')}.`) : null,
  (f) => f.extraction.conflicts.length ? fire('EXTRACTION_CONFLICT', 'HOLD', 'HIGH', `Extraction methods disagree on: ${f.extraction.conflicts.join(', ')}.`) : null,
  (f) => f.extraction.amountDiffersFromInvoice ? fire('AMOUNT_DIFFERS_FROM_INVOICE', 'HOLD', 'CRITICAL', 'The requested amount differs from the invoice total.') : null,
  (f) => f.extraction.totals === 'CONFLICT' ? fire('TOTALS_INCONSISTENT', 'HOLD', 'HIGH', 'The invoice total does not equal its line items and tax.') : null,

  // Policy limits.
  (f, p) => f.amount.minor !== null && f.amount.minor <= 0 ? fire('AMOUNT_INVALID', 'DENY', 'HIGH', 'The amount must be greater than zero.') : null,
  (f, p) => f.amount.minor !== null && f.amount.minor > p.hardLimitMinor ? fire('HARD_LIMIT_EXCEEDED', 'DENY', 'HIGH', `The amount is above the workspace limit of ${money(p.hardLimitMinor)}.`) : null,
  (f, p) => f.amount.currency && !p.allowedCurrencies.includes(f.amount.currency) ? fire('CURRENCY_NOT_ALLOWED', 'HOLD', 'MEDIUM', `${f.amount.currency} is not an allowed currency.`) : null,
  (f) => f.vendor.status === 'VERIFIED' && !f.vendor.currencyApproved ? fire('VENDOR_CURRENCY_MISMATCH', 'HOLD', 'MEDIUM', 'This vendor is not approved for this currency.') : null,
  (f) => f.vendor.status === 'VERIFIED' && !f.vendor.categoryApproved ? fire('VENDOR_CATEGORY_MISMATCH', 'REVIEW', 'MEDIUM', 'This category is unusual for this vendor.') : null,

  // Fail closed on missing verification services.
  (f, p) => p.requireEvidenceService && !f.evidence.registryAvailable ? fire('VERIFICATION_UNAVAILABLE', 'HOLD', 'CRITICAL', 'A required verification service is unavailable. The request cannot be treated as safe.') : null,

  // Approval integrity.
  (f) => f.approval.rejected ? fire('APPROVAL_REJECTED', 'DENY', 'HIGH', 'A reviewer rejected this exact transaction.') : null,
  (f) => f.lifecycle.expired ? fire('REQUEST_EXPIRED', 'HOLD', 'MEDIUM', 'This request expired. Submit it again.') : null,

  // Reasons a human may resolve.
  (f, p) => f.amount.minor !== null && f.amount.minor > p.approvalThresholdMinor && f.amount.minor <= p.hardLimitMinor ? fire('APPROVAL_THRESHOLD', 'REVIEW', 'MEDIUM', `Amounts above ${money(p.approvalThresholdMinor)} need human approval.`) : null,
  (f, p) => p.unusualAmountMultiple > 0 && f.amount.minor !== null && f.amount.maxHistoricalMinor !== null && f.amount.minor > f.amount.maxHistoricalMinor * p.unusualAmountMultiple ? fire('AMOUNT_UNUSUAL', 'REVIEW', 'MEDIUM', `The amount is more than ${p.unusualAmountMultiple} times this vendor’s largest earlier invoice.`) : null,
  (f, p) => p.requirePurchaseOrder && !f.amount.purchaseOrderPresent ? fire('PURCHASE_ORDER_MISSING', 'REVIEW', 'MEDIUM', 'Policy requires a purchase order and none was found.') : null,
  (f, p) => f.signals.urgency > 0 && p.urgencyAction === 'REVIEW' ? fire('URGENCY_LANGUAGE', 'REVIEW', 'LOW', 'The message pressures for unusual speed or secrecy.') : null,
  (f, p) => f.signals.injection > 0 ? fire('EMBEDDED_INSTRUCTIONS', p.injectionAction, 'HIGH', 'The document contains instructions aimed at software. They were ignored and treated as a warning sign.') : null,
  (f, p) => f.signals.websiteInjection > 0 ? fire('WEBSITE_INSTRUCTIONS', p.injectionAction, 'MEDIUM', 'The vendor website contains instructions aimed at software. They were ignored.') : null,
  (f) => f.extraction.modelOnly.length ? fire('MODEL_ONLY_FIELDS', 'REVIEW', 'MEDIUM', `Only the AI model could read: ${f.extraction.modelOnly.join(', ')}. A person should confirm them.`) : null,
  (f) => f.signals.modelFindings > 0 ? fire('MODEL_RAISED_CONCERN', 'REVIEW', 'MEDIUM', 'The AI investigator raised a concern. A person should read it.') : null,
];

export const RULE_COUNT = rules.length;

export function evaluate(facts: Facts, policy: PolicyRules): Evaluation {
  const fired: Reason[] = [];
  for (const rule of rules) {
    const r = rule(facts, policy);
    if (r) fired.push({ ...r, approvable: r.effect === 'REVIEW' });
  }
  // An approval covers only the reasons the approver actually saw.
  const satisfiedByApproval = facts.approval.valid ? fired.filter((r) => r.approvable && facts.approval.reviewedCodes.includes(r.code)).map((r) => r.code) : [];
  const active = fired.filter((r) => !satisfiedByApproval.includes(r.code));
  const decision = active.reduce<Decision>((d, r) => (RANK[r.effect] > RANK[d] ? r.effect : d), 'ALLOW');
  fired.sort((a, b) => RANK[b.effect] - RANK[a.effect]);
  return { decision, reasons: fired, satisfiedByApproval, rulesChecked: rules.length };
}
