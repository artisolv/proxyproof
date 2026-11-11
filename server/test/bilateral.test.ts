import { describe, expect, it } from 'vitest';
import { codes, failCodes, setup } from './helpers.js';

/**
 * The plan's scenarios, driven through the same public API as any agent. Expectations follow from each agent's real
 * credentials and the technique used; no scenario name reaches the server.
 */
describe('bilateral verification', () => {
  it('1. both sides valid: ALLOW with both authority chains and the match recorded, and a single-use permit', async () => {
    const t = await setup();
    const { o, a } = await t.validPair();
    expect(o.decision).toBe('HOLD');
    expect(codes(o)).toEqual(['BUYER_AUTHORIZATION_PENDING']);
    expect(o.checks.filter((c: any) => c.group === 'seller').every((c: any) => c.state === 'pass')).toBe(true);
    expect(a.decision).toBe('ALLOW');
    expect(a.checks.filter((c: any) => c.group === 'buyer').every((c: any) => c.state === 'pass')).toBe(true);
    expect(a.checks.filter((c: any) => c.group === 'match').every((c: any) => c.state === 'pass')).toBe(true);
    expect(a.permit.action).toBe('create_checkout');
    expect(a.permit.expires_in_s).toBe(300);
    expect(a.payment_state).toBe('NOT_STARTED');
  });

  it('2. seller agent not authorized to invoice: DENY, never presented as a verified seller request', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Support Agent', 'Northwind Hotels', [['Espresso machine service visit', 1]]);
    expect(o.decision).toBe('DENY');
    expect(failCodes(o)).toEqual(['ACTION_NOT_PERMITTED']);
    // The buyer cannot rescue it by accepting.
    const a = await t.accept('Northwind Procurement Agent', o.transaction_id);
    expect(a.decision).toBe('DENY');
    expect(a.permit).toBeNull();
    // A quote is within that same agent's authority.
    const q = await t.offer('Harbor & Pine Support Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]], { document: 'QUOTE' });
    expect(failCodes(q)).toEqual([]);
  });

  it('3. buyer over its limit: DENY; between the approval threshold and the limit: REVIEW, then ALLOW after approval', async () => {
    const t = await setup();
    const big = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['Espresso machine', 1]]);
    const a = await t.accept('Northwind Procurement Agent', big.transaction_id);
    expect(a.decision).toBe('DENY');
    expect(failCodes(a)).toEqual(['AMOUNT_EXCEEDS_LIMIT']);
    const mid = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['Burr grinder', 1], ['House Blend, 5 lb', 1]]);
    const r = await t.accept('Northwind Procurement Agent', mid.transaction_id);
    expect(r.decision).toBe('REVIEW');
    expect(codes(r)).toEqual(['REVIEW_REQUIRED']);
    expect(r.permit).toBeNull();
    const ok = await t.post(`/api/transactions/${mid.transaction_id}/review`);
    expect(ok.json.decision).toBe('ALLOW');
    expect(ok.json.permit.jws).toBeTruthy();
  });

  it('4. same owner, different agent: the research agent fails on authority, the procurement agent passes', async () => {
    const t = await setup();
    const o1 = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 2]]);
    const research = await t.accept('Northwind Research Agent', o1.transaction_id);
    expect(research.decision).toBe('DENY');
    expect(failCodes(research)).toEqual(['ACTION_NOT_PERMITTED']);
    const o2 = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 2]]);
    expect((await t.accept('Northwind Procurement Agent', o2.transaction_id)).decision).toBe('ALLOW');
  });

  it('5. terms changed after approval: the earlier authorization and permit no longer apply', async () => {
    const t = await setup();
    const { id, a } = await t.validPair();
    expect(a.decision).toBe('ALLOW');
    const revised = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 3]], { transaction_id: id });
    expect(revised.version).toBe(2);
    expect(revised.decision).toBe('HOLD');
    expect(codes(revised)).toEqual(['BUYER_AUTHORIZATION_PENDING']);
    const old = await t.execute(id, a.permit.jws);
    expect(old.status).toBe(403);
    expect(old.json.code).toBe('TERMS_CHANGED');
    // A fresh acceptance of the new terms is required, and works.
    expect((await t.accept('Northwind Procurement Agent', id)).decision).toBe('ALLOW');
  });

  it('5b. a buyer agent that authorizes different terms from those on the table is refused', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 2]]);
    const a = await t.accept('Northwind Procurement Agent', o.transaction_id, 'sign_different_terms');
    expect(a.decision).toBe('DENY');
    expect(failCodes(a)).toEqual(['TERMS_MISMATCH']);
  });

  it('6. wrong payment destination: DENY before any payment', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]], { pay_to: 'billing@harb0r-pine.example' });
    expect(failCodes(o)).toEqual(['DESTINATION_NOT_AUTHORIZED']);
  });

  it('7. expired and revoked authority, on both sides', async () => {
    const t = await setup();
    expect(failCodes(await t.offer('Harbor & Pine Seasonal Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]]))).toEqual(['DELEGATION_EXPIRED']);
    expect(failCodes(await t.offer('Harbor & Pine Legacy Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]]))).toEqual(['DELEGATION_REVOKED']);
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]]);
    expect(failCodes(await t.accept('Northwind Events Agent', o.transaction_id))).toEqual(['DELEGATION_EXPIRED']);
    const o2 = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]]);
    expect(failCodes(await t.accept('Northwind Ops Agent', o2.transaction_id))).toEqual(['DELEGATION_REVOKED']);
  });

  it('8. invalid seller signature, forged or self-issued authority, unknown keys and missing proof are rejected', async () => {
    const t = await setup();
    const H: [string, number][] = [['House Blend, 5 lb', 1]];
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'wrong_key_signature' }))).toEqual(['SIGNATURE_INVALID']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'forged_delegation' }))).toEqual(['DELEGATION_FORGED']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'self_signed_delegation' }))).toEqual(['SELF_DELEGATION']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'foreign_issuer' }))).toEqual(['WRONG_ISSUER']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'unregistered_key' }))).toEqual(['AGENT_UNKNOWN']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'unsigned' }))).toEqual(['REQUEST_MALFORMED']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'stale_request' }))).toEqual(['REQUEST_STALE']);
    expect(failCodes(await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H, { behaviour: 'tamper_after_signing' }))).toEqual(['TERMS_MODIFIED']);
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', H);
    expect(failCodes(await t.accept('Northwind Procurement Agent', o.transaction_id, 'omit_delegation'))).toEqual(['DELEGATION_MISSING']);
  });

  it('9. replayed requests are refused on both sides', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]], { behaviour: 'replay' });
    expect(failCodes(o)).toEqual(['REPLAY']);
    const o2 = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]]);
    expect(failCodes(await t.accept('Northwind Procurement Agent', o2.transaction_id, 'replay'))).toEqual(['REPLAY']);
  });

  it('unverified organizations are held, not trusted and not denied', async () => {
    const t = await setup();
    const o = await t.offer('Bayside Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]], { pay_to: 'payments@bayside.example' });
    expect(o.decision).toBe('HOLD');
    expect(codes(o)).toEqual(['ORG_NOT_ESTABLISHED', 'BUYER_AUTHORIZATION_PENDING']);
  });

  it('11. verification dependency unavailable: HOLD, then recovery after it returns', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 2]]);
    await t.post('/api/settings/status-service', { up: false });
    const a = await t.accept('Northwind Procurement Agent', o.transaction_id);
    expect(a.decision).toBe('HOLD');
    expect(codes(a)).toEqual(['STATUS_UNAVAILABLE', 'STATUS_UNAVAILABLE']);
    await t.post('/api/settings/status-service', { up: true });
    const again = await t.post(`/api/transactions/${o.transaction_id}/recheck`);
    expect(again.json.decision).toBe('ALLOW');
  });

  it('expired terms cannot be accepted', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]], { expires_in_s: -60 });
    expect(failCodes(await t.accept('Northwind Procurement Agent', o.transaction_id))).toEqual(['TERMS_EXPIRED']);
  });

  it('the path stops at the first failed check on each side', async () => {
    const t = await setup();
    const o = await t.offer('Harbor & Pine Sales Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]], { behaviour: 'unregistered_key' });
    const seller = o.checks.filter((c: any) => c.group === 'seller').map((c: any) => c.state);
    expect(seller[0]).toBe('fail');
    expect(seller.slice(1).every((s: string) => s === 'not_reached')).toBe(true);
  });
});
