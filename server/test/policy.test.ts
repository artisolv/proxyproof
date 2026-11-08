import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, evaluate, type Facts } from '../src/policy/engine.js';

const clean = (): Facts => ({
  origin: 'HUMAN', agent: null,
  vendor: { status: 'VERIFIED', currencyApproved: true, categoryApproved: true, nameMismatch: false, resembles: null },
  destination: { status: 'MATCH', railSupported: true },
  sender: { present: false, domain: 'NONE', replyTo: 'NONE', authFailed: false },
  extraction: { criticalUnknown: [], conflicts: [], totals: 'CONSISTENT', maliciousFile: false, modelOnly: [], amountDiffersFromInvoice: false },
  duplicates: { alreadyPaid: false, paymentInFlight: false, exactFile: false, sameNumber: false, semantic: false, repeatWithoutInvoice: false },
  amount: { minor: 129600, currency: 'USD', maxHistoricalMinor: 129600, purchaseOrderPresent: true },
  signals: { injection: 0, urgency: 0, modelFindings: 0, websiteInjection: 0 },
  evidence: { registryAvailable: true, unavailable: [] },
  approval: { valid: false, stale: false, rejected: false, reviewedCodes: ['APPROVAL_THRESHOLD'] }, lifecycle: { expired: false },
});
const agent = () => ({ registered: true, active: true, signature: 'VALID' as const, grant: 'VALID' as const, replayedNonce: false, amountInScope: true, categoryInScope: true, vendorInScope: true, currencyInScope: true, actionInScope: true, dailyBudgetOk: true, monthlyBudgetOk: true, grantPolicyVersionCurrent: true });
const with_ = (patch: (f: Facts) => void) => { const f = clean(); patch(f); return evaluate(f, DEFAULT_RULES); };

describe('deterministic policy engine', () => {
  it('allows a clean request and fires nothing', () => {
    const r = evaluate(clean(), DEFAULT_RULES);
    expect(r.decision).toBe('ALLOW');
    expect(r.reasons).toEqual([]);
  });
  it('is deterministic for identical facts', () => {
    expect(evaluate(clean(), DEFAULT_RULES)).toEqual(evaluate(clean(), DEFAULT_RULES));
  });
  it.each([
    ['destination mismatch', (f: Facts) => { f.destination.status = 'MISMATCH'; }, 'HOLD', 'DESTINATION_MISMATCH'],
    ['unknown vendor', (f: Facts) => { f.vendor.status = 'UNKNOWN'; f.destination.status = 'NO_TRUSTED_RECORD'; }, 'HOLD', 'VENDOR_UNKNOWN'],
    ['revoked vendor', (f: Facts) => { f.vendor.status = 'REVOKED'; }, 'DENY', 'VENDOR_REVOKED'],
    ['already paid', (f: Facts) => { f.duplicates.alreadyPaid = true; }, 'DENY', 'ALREADY_PAID'],
    ['critical unknown', (f: Facts) => { f.extraction.criticalUnknown = ['total amount']; }, 'HOLD', 'CRITICAL_FIELD_UNKNOWN'],
    ['registry down', (f: Facts) => { f.evidence.registryAvailable = false; }, 'HOLD', 'VERIFICATION_UNAVAILABLE'],
    ['hard limit', (f: Facts) => { f.amount.minor = DEFAULT_RULES.hardLimitMinor + 1; }, 'DENY', 'HARD_LIMIT_EXCEEDED'],
    ['approval threshold', (f: Facts) => { f.amount.minor = DEFAULT_RULES.approvalThresholdMinor + 1; f.amount.maxHistoricalMinor = 9_999_999; }, 'REVIEW', 'APPROVAL_THRESHOLD'],
    ['lookalike', (f: Facts) => { f.sender.domain = 'LOOKALIKE'; }, 'HOLD', 'SENDER_LOOKALIKE_DOMAIN'],
    ['injection', (f: Facts) => { f.signals.injection = 1; }, 'REVIEW', 'EMBEDDED_INSTRUCTIONS'],
    ['agent unregistered', (f: Facts) => { f.origin = 'AGENT'; f.agent = { ...agent(), registered: false }; }, 'DENY', 'AGENT_NOT_REGISTERED'],
    ['agent expired', (f: Facts) => { f.origin = 'AGENT'; f.agent = { ...agent(), grant: 'EXPIRED' }; }, 'DENY', 'AUTH_EXPIRED'],
    ['agent replay', (f: Facts) => { f.origin = 'AGENT'; f.agent = { ...agent(), replayedNonce: true }; }, 'DENY', 'AGENT_REPLAY'],
    ['agent over budget', (f: Facts) => { f.origin = 'AGENT'; f.agent = { ...agent(), dailyBudgetOk: false }; }, 'DENY', 'AUTH_DAILY_BUDGET_EXCEEDED'],
  ])('%s', (_n, patch, decision, code) => {
    const r = with_(patch);
    expect(r.decision).toBe(decision);
    expect(r.reasons.map((x) => x.code)).toContain(code);
  });

  it('a recorded approval satisfies only REVIEW reasons, never HOLD or DENY', () => {
    const f = clean(); f.amount.minor = 600000; f.amount.maxHistoricalMinor = 9_999_999; f.approval.valid = true;
    expect(evaluate(f, DEFAULT_RULES).decision).toBe('ALLOW');
    f.destination.status = 'MISMATCH';
    const r = evaluate(f, DEFAULT_RULES);
    expect(r.decision).toBe('HOLD');
    expect(r.satisfiedByApproval).toEqual(['APPROVAL_THRESHOLD']);
  });
  it('an approval does not cover reasons that appear after it', () => {
    const f = clean(); f.amount.minor = 600000; f.amount.maxHistoricalMinor = 9_999_999; f.approval.valid = true; f.signals.urgency = 1;
    const r = evaluate(f, DEFAULT_RULES);
    expect(r.decision).toBe('REVIEW');
    expect(r.satisfiedByApproval).toEqual(['APPROVAL_THRESHOLD']);
  });
  it('model output can raise but never lower a decision', () => {
    const f = clean(); f.signals.modelFindings = 3;
    expect(evaluate(f, DEFAULT_RULES).decision).toBe('REVIEW');
    const g = clean(); g.destination.status = 'MISMATCH'; g.signals.modelFindings = 0;
    expect(evaluate(g, DEFAULT_RULES).decision).toBe('HOLD');
  });
  it('policy changes alter configurable rules only', () => {
    const f = clean(); f.vendor.status = 'PENDING';
    expect(evaluate(f, DEFAULT_RULES).decision).toBe('HOLD');
    expect(evaluate(f, { ...DEFAULT_RULES, newVendorAction: 'REVIEW' }).decision).toBe('REVIEW');
    f.destination.status = 'NO_TRUSTED_RECORD';
    expect(evaluate(f, { ...DEFAULT_RULES, newVendorAction: 'REVIEW' }).decision).toBe('HOLD');
    const g = clean(); g.sender.domain = 'LOOKALIKE';
    expect(evaluate(g, { ...DEFAULT_RULES, lookalikeAction: 'DENY' }).decision).toBe('DENY');
  });
});
