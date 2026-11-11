import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { setup } from './helpers.js';
import { startMockPayPal } from './mockPaypal.js';
import { newKeyPair, signingKey } from '../src/trust/keys.js';
import { one } from '../src/db/index.js';

let mock: Awaited<ReturnType<typeof startMockPayPal>> | null = null;
afterEach(async () => { await mock?.close(); mock = null; });
const live = async () => { mock = await startMockPayPal(); return setup({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_BASE_URL: mock.url }); };

describe('protected execution boundary', () => {
  it('a valid permit opens a PayPal checkout; COMPLETED only after PayPal confirms the capture', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    const ex = await t.execute(id, a.permit.jws);
    expect(ex.status).toBe(200);
    expect(ex.json.payment_state).toBe('AWAITING_BUYER_APPROVAL');
    expect(ex.json.payment.payer_link).toMatch(/sandbox\.paypal\.com/);
    expect(ex.json.decision).toBe('ALLOW'); // the decision and the payment state stay separate
    const body = JSON.parse(mock!.calls.find((c) => c.path === '/v2/checkout/orders')!.body);
    expect(body.purchase_units[0].amount.value).toBe('136.00');
    mock!.state.orderApproved = true;
    const cap = await t.post(`/api/transactions/${id}/capture`);
    expect(cap.json.payment_state).toBe('COMPLETED');
    expect(cap.json.payment.confirmed_by).toBe('Authenticated PayPal API lookup');
  });

  it('12. bypass: no permit, a forged permit, or a permit for another transaction is refused, and PayPal is never called', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    expect((await t.execute(id)).json.code).toBe('PERMIT_MISSING');
    const k = newKeyPair();
    const forged = await new SignJWT({ act: 'create_checkout', terms_hash: 'x', decision_receipt_sha256: 'x' }).setProtectedHeader({ alg: 'EdDSA', typ: 'execution-permit+jwt' }).setAudience('proxyproof-executor').setSubject(id).setJti('pmt_forged').setExpirationTime('5m').sign(await signingKey(k.privatePem));
    expect((await t.execute(id, forged)).json.code).toBe('PERMIT_INVALID');
    const other = await t.validPair();
    expect((await t.execute(other.id, a.permit.jws)).json.code).toBe('PERMIT_WRONG_TRANSACTION');
    // Held, reviewed and denied transactions have no permit to spend.
    const denied = await t.offer('Harbor & Pine Legacy Agent', 'Northwind Hotels', [['House Blend, 5 lb', 1]]);
    expect((await t.execute(denied.transaction_id, a.permit.jws)).status).toBe(403);
    expect(mock!.railCalls()).toHaveLength(0);
  });

  it('9. a permit is single use: a second execution is refused and recorded', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    expect((await t.execute(id, a.permit.jws)).status).toBe(200);
    const again = await t.execute(id, a.permit.jws);
    expect(again.json.code).toBe('PERMIT_ALREADY_USED');
    expect(mock!.railCalls().filter((c) => c.path === '/v2/checkout/orders')).toHaveLength(1);
    expect(one<any>(t.db, `SELECT COUNT(*) c FROM audit_events WHERE event_type = 'EXECUTOR_REFUSED'`).c).toBe(1);
  });

  it('concurrent executions with two valid permits create one checkout', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    await t.post('/api/settings/status-service', { up: true });
    const second = (await t.post(`/api/transactions/${id}/recheck`).catch(() => null));
    expect(second?.status).toBe(409); // not held, so no second permit from recheck
    const results = await Promise.all([t.execute(id, a.permit.jws), t.execute(id, a.permit.jws)]);
    expect(results.filter((r: { status: number }) => r.status === 200)).toHaveLength(1);
    expect(mock!.railCalls().filter((c) => c.path === '/v2/checkout/orders')).toHaveLength(1);
  });

  it('time of use: revoking the seller agent after approval stops execution at the boundary', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    const seller = await t.agent('Harbor & Pine Sales Agent');
    await t.post(`/api/delegations/${seller.delegation.id}/revoke`);
    const ex = await t.execute(id, a.permit.jws);
    expect(ex.json.code).toBe('LIVE_RECHECK_FAILED');
    expect(ex.json.error).toMatch(/revoked/i);
    expect(mock!.railCalls()).toHaveLength(0);
  });

  it('revoking after checkout opened prevents capture', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    await t.execute(id, a.permit.jws);
    const buyer = await t.agent('Northwind Procurement Agent');
    await t.post(`/api/delegations/${buyer.delegation.id}/revoke`);
    mock!.state.orderApproved = true;
    const cap = await t.post(`/api/transactions/${id}/capture`);
    expect(cap.json.code).toBe('LIVE_RECHECK_FAILED');
    expect(mock!.calls.some((c) => c.path.endsWith('/capture'))).toBe(false);
  });

  it('unverified webhooks change nothing', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    await t.execute(id, a.permit.jws);
    mock!.state.captured = true;
    const hook = await t.app.request('/api/paypal/webhooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { supplementary_data: { related_ids: { order_id: 'ORDER1' } } } }) });
    expect(hook.status).toBe(400);
    expect((await t.get(`/api/transactions/${id}`)).payment_state).toBe('AWAITING_BUYER_APPROVAL');
  });

  it('the evidence bundle links both chains, verifies, and detects tampering', async () => {
    const t = await live();
    const { id, a } = await t.validPair();
    await t.execute(id, a.permit.jws);
    const proof = await t.get(`/api/v1/workspaces/${t.ws}/transactions/${id}/proof`);
    expect(proof.bundle.seller.organization.name).toBe('Harbor & Pine Roasters');
    expect(proof.bundle.buyer.organization.name).toBe('Northwind Hotels');
    expect(proof.bundle.seller.delegation_credential.split('.').length).toBe(3);
    expect(proof.bundle.payment.state).toBe('AWAITING_BUYER_APPROVAL');
    const ok = await t.post('/api/v1/proofs/verify', { bundle: proof.bundle, signature: proof.signature });
    expect(ok.json).toMatchObject({ signature: true, digest_matches: true, decision_receipt: true, decision: 'ALLOW' });
    const tampered = structuredClone(proof.bundle); tampered.transaction.terms.total_minor = 1;
    expect((await t.post('/api/v1/proofs/verify', { bundle: tampered, signature: proof.signature })).json.digest_matches).toBe(false);
  });
});

describe('architecture', () => {
  it('only the executor and app wiring can reach the PayPal client', () => {
    const root = join(__dirname, '../src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
    const importers = files(root).filter((f) => f.endsWith('.ts') && /from '.*executor\/paypal\.js'|from '\.\/paypal\.js'/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1)).sort();
    expect(importers).toEqual(['app.ts', 'executor/gate.ts']);
  });
  it('the MCP connector cannot reach the PayPal client or private key tables directly', () => {
    const src = readFileSync(join(__dirname, '../src/mcp/server.ts'), 'utf8');
    expect(src).not.toMatch(/executor\/paypal|private_pem|principal_keys/);
  });
});
