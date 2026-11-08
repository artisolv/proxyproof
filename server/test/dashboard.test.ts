import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { all, one } from '../src/db/index.js';

const H = { 'x-payeeproof': '1' };
async function demo(t: Awaited<ReturnType<typeof setup>>) {
  const res = await t.app.request('/api/demo/start', { method: 'POST', headers: H });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const { workspaceId } = await res.json() as any;
  const get = async (p: string) => (await t.app.request(p, { headers: { ...H, cookie } })).json() as any;
  const post = async (p: string, body: unknown = {}) => t.app.request(p, { method: 'POST', headers: { ...H, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { cookie, workspaceId, get, post };
}

describe('dashboard and sample activity', () => {
  it('runs every sample through the real pipeline and reports what the policy engine decided', async () => {
    const t = await setup({ env: { DEMO_SAMPLES: 'on' } });
    const d = await demo(t);
    const dash = await d.get('/api/dashboard');
    const tx = (await d.get('/api/transactions')).transactions as any[];
    const byRef = Object.fromEntries(tx.map((x) => [x.reference, x]));

    // Expected outcomes follow from the evidence, not from labels.
    expect(byRef['INV-2038'].outcome).toBe('ALLOWED');
    expect(byRef['INV-2038'].initiator.kind).toBe('AGENT');
    expect(byRef['INV-2039'].outcome).toBe('ALLOWED');
    expect(byRef['INV-2042'].outcome).toBe('HELD');
    expect(byRef['INV-2042'].reasonCodes).toContain('DESTINATION_MISMATCH');
    expect(byRef['MOS-5601'].reasonCodes).toContain('TOTALS_INCONSISTENT');
    expect(byRef['INV-2050'].outcome).toBe('DENIED');
    expect(byRef['INV-2050'].reasonCodes).toContain('AUTH_AMOUNT_EXCEEDED');
    expect(byRef['MOS-5600'].outcome).toBe('DENIED');
    expect(byRef['MOS-5600'].reasonCodes).toContain('AUTH_VENDOR_OUT_OF_SCOPE');
    expect(byRef['INV-2040'].outcome).toBe('UNDER_REVIEW');
    expect(byRef['INV-2040'].reasonCodes).toContain('EMBEDDED_INSTRUCTIONS');
    expect(byRef['HD-77'].reasonCodes).toContain('VENDOR_UNKNOWN');
    expect(byRef['AL-352'].outcome).toBe('UNDER_REVIEW');
    expect(byRef['INV 2039'].outcome).toBe('HELD');
    expect(byRef['INV 2039'].reasonCodes).toContain('DUPLICATE_INVOICE_NUMBER');
    expect(byRef['INV-2040'].reason).toMatch(/instructions aimed at software/);

    // Every number on the dashboard equals a count of stored records.
    const decided = all<any>(t.db, `SELECT (SELECT decision FROM policy_decisions d WHERE d.payment_request_id = r.id ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1) dec FROM payment_requests r WHERE r.workspace_id = ?`, d.workspaceId);
    expect(dash.total).toBe(decided.length);
    expect(dash.counts.ALLOWED).toBe(decided.filter((x) => x.dec === 'ALLOW').length);
    expect(dash.counts.HELD).toBe(decided.filter((x) => x.dec === 'HOLD').length);
    expect(dash.counts.DENIED).toBe(decided.filter((x) => x.dec === 'DENY').length);
    expect(dash.counts.UNDER_REVIEW).toBe(decided.filter((x) => x.dec === 'REVIEW').length);
    // Nothing is paid until PayPal confirms a real attempt.
    expect(dash.counts.COMPLETED).toBe(0);
    expect(dash.amounts.paidMinor).toBe(0);
    expect(one<any>(t.db, `SELECT COUNT(*) c FROM payment_attempts WHERE workspace_id = ? AND provider = 'PAYPAL_SANDBOX'`, d.workspaceId).c).toBe(0);
    expect(dash.payees.destChanges.map((x: any) => x.requested)).toContain('northwind-billing@payments-desk.example');
    expect(dash.insights.map((i: any) => i.key)).toEqual(expect.arrayContaining(['destination', 'agent', 'duplicate', 'invoice', 'injection', 'vendor']));
  });

  it('never lets a held or denied sample reach the executor', async () => {
    const t = await setup({ env: { DEMO_SAMPLES: 'on' } });
    const d = await demo(t);
    const tx = (await d.get('/api/transactions')).transactions as any[];
    for (const x of tx.filter((y) => ['HELD', 'DENIED', 'UNDER_REVIEW'].includes(y.outcome))) {
      const res = await d.post(`/api/payment-requests/${x.id}/execute`);
      expect(res.status).toBe(403);
    }
    expect(one<any>(t.db, `SELECT COUNT(*) c FROM payment_attempts WHERE workspace_id = ? AND provider = 'PAYPAL_SANDBOX'`, d.workspaceId).c).toBe(0);
  });

  it('explains an allowed request from the facts that were checked', async () => {
    const t = await setup({ env: { DEMO_SAMPLES: 'on' } });
    const d = await demo(t);
    const tx = (await d.get('/api/transactions')).transactions as any[];
    const ok = tx.find((x) => x.reference === 'INV-2038');
    expect(ok.reason).toMatch(/Verified vendor, matching verified destination/);
    const c = await d.get(`/api/payment-requests/${ok.id}`);
    expect(c.assessment.checks.find((x: any) => x.key === 'destination').state).toBe('pass');
    expect(c.assessment.checks.find((x: any) => x.key === 'authority').state).toBe('pass');
    const bad = await d.get(`/api/payment-requests/${tx.find((x) => x.reference === 'INV-2042').id}`);
    expect(bad.assessment.checks.find((x: any) => x.key === 'destination').state).toBe('fail');
  });
});
