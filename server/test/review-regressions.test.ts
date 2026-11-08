import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, RECEIVER } from './helpers.js';
import { startMockPayPal } from './mockPaypal.js';
import { analyze, createRequest } from '../src/pipeline.js';
import { executePayment, GateRefused } from '../src/executor/gate.js';
import { invoicePdf, northwindInvoice } from '../src/challenge/fixtures.js';

let mock: Awaited<ReturnType<typeof startMockPayPal>>;
beforeAll(async () => { mock = await startMockPayPal(); });
afterAll(async () => { await mock.close(); });
const env = () => ({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_BASE_URL: mock.url });
const fin = (t: any) => ({ workspaceId: t.s.ws, actor: { type: 'USER' as const, id: t.s.finance }, role: 'FINANCE_ADMIN' });
const manual = async (t: any, files: { filename: string; bytes: Uint8Array }[]) => {
  const id = createRequest(t.db, { workspaceId: t.s.ws, origin: 'HUMAN', submittedBy: t.s.owner, vendorId: t.s.northwind, category: 'hosting', payment: { amount_minor: 129600, currency: 'USD' } as any }, { type: 'USER', id: t.s.owner });
  return { id, ...(await analyze(t.ctx, id, files, { type: 'USER', id: t.s.owner })) };
};

describe('fixes from the independent security review', () => {
  it('an unreadable file holds instead of passing without an invoice', async () => {
    const t = await setup({ env: env() });
    const blank = await invoicePdf({ vendor: '', number: '', items: [], total: '' } as any).then(() => new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')));
    const r = await manual(t, [{ filename: 'scan.pdf', bytes: blank }]);
    expect(r.decision).toBe('HOLD');
  });
  it('the same amount to the same vendor without an invoice cannot be paid twice', async () => {
    const t = await setup({ env: env() });
    const a = await manual(t, []);
    expect(a.decision).toBe('ALLOW');
    await executePayment(t.ctx, fin(t), a.id, a.decisionId);
    const b = await manual(t, []);
    expect(b.decision).toBe('HOLD');
    expect(b.reasons.map((x) => x.code)).toContain('POSSIBLE_REPEAT_PAYMENT');
    await expect(executePayment(t.ctx, fin(t), b.id, b.decisionId)).rejects.toBeInstanceOf(GateRefused);
  });
  it('an anonymous agent post cannot plant an invoice that blocks the real one', async () => {
    const t = await setup({ env: env() });
    const file = await invoicePdf(northwindInvoice(RECEIVER, { number: 'INV-7777' }));
    const res = await t.app.request(`/api/agent/${t.s.ws}/payment-requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: { agent_id: 'nobody', authorization: '', nonce: 'n', timestamp: new Date().toISOString(), payment: { amount_minor: 129600, currency: 'USD', category: 'hosting' } }, files: [{ filename: 'x.pdf', base64: Buffer.from(file).toString('base64') }] }) });
    expect((await res.json() as any).decision).toBe('DENY');
    const id = createRequest(t.db, { workspaceId: t.s.ws, origin: 'HUMAN', submittedBy: t.s.owner, category: 'hosting' }, { type: 'USER', id: t.s.owner });
    const real = await analyze(t.ctx, id, [{ filename: 'i.pdf', bytes: file }], { type: 'USER', id: t.s.owner });
    expect(real.decision).toBe('ALLOW');
  });
  it('switching the payment rail after ALLOW issues a new decision', async () => {
    const t = await setup({ env: env() });
    const cookie = (await t.app.request('/api/demo/start', { method: 'POST', headers: { 'x-payeeproof': '1' } })).headers.get('set-cookie')!.split(';')[0];
    const form = new FormData();
    form.append('files', new Blob([<any>await invoicePdf(northwindInvoice(RECEIVER, { number: 'INV-RAIL' }))]), 'i.pdf');
    const { id } = await (await t.app.request('/api/payment-requests', { method: 'POST', headers: { cookie, 'x-payeeproof': '1' }, body: form })).json() as any;
    const before = await (await t.app.request(`/api/payment-requests/${id}`, { headers: { cookie } })).json() as any;
    await t.app.request(`/api/payment-requests/${id}/rail`, { method: 'POST', headers: { cookie, 'x-payeeproof': '1', 'content-type': 'application/json' }, body: JSON.stringify({ rail: 'ORDERS' }) });
    const res = await t.app.request(`/api/payment-requests/${id}/execute`, { method: 'POST', headers: { cookie, 'x-payeeproof': '1', 'content-type': 'application/json' }, body: JSON.stringify({ decision_id: before.decision.id }) });
    expect(res.status).toBe(403);
  });
  it('caps sandbox payments per workspace', async () => {
    const t = await setup({ env: { ...env(), SANDBOX_PAYMENTS_PER_WORKSPACE: '0' } });
    const cookie = (await t.app.request('/api/demo/start', { method: 'POST', headers: { 'x-payeeproof': '1' } })).headers.get('set-cookie')!.split(';')[0];
    const res = await t.app.request('/api/challenge/run', { method: 'POST', headers: { cookie, 'x-payeeproof': '1', 'content-type': 'application/json' }, body: JSON.stringify({ scenarios: ['T18'] }) });
    expect(res.status).toBe(429);
  });
});
