import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setup, RECEIVER } from './helpers.js';
import { startMockPayPal } from './mockPaypal.js';
import { analyze, createRequest, latestDecision } from '../src/pipeline.js';
import { invoicePdf, northwindInvoice, ATTACKER_PAYPAL } from '../src/challenge/fixtures.js';
import { executePayment, GateRefused, handleWebhook, syncAttempt } from '../src/executor/gate.js';
import { bypassSuite } from '../src/challenge/scenarios.js';
import { createPayPal } from '../src/executor/paypal.js';
import { verifyChain } from '../src/core/ledger.js';
import { loadConfig } from '../src/config.js';
import { sha256 } from '../src/core/util.js';

let mock: Awaited<ReturnType<typeof startMockPayPal>>;
beforeAll(async () => { mock = await startMockPayPal(); });
afterAll(async () => { await mock.close(); });
const env = () => ({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: 'WH-1', PAYPAL_BASE_URL: mock.url });

async function upload(t: Awaited<ReturnType<typeof setup>>, spec = northwindInvoice(RECEIVER, { number: `INV-${Math.random().toString().slice(2, 8)}` })) {
  const id = createRequest(t.db, { workspaceId: t.s.ws, origin: 'HUMAN', principalId: t.s.owner, submittedBy: t.s.owner, category: 'hosting' }, { type: 'USER', id: t.s.owner });
  const r = await analyze(t.ctx, id, [{ filename: 'i.pdf', bytes: await invoicePdf(spec) }], { type: 'USER', id: t.s.owner });
  return { id, ...r };
}
const finance = (t: any) => ({ workspaceId: t.s.ws, actor: { type: 'USER' as const, id: t.s.finance }, role: 'FINANCE_ADMIN' });

describe('payment executor', () => {
  it('pays a permitted request once, and confirms only through the provider', async () => {
    const t = await setup({ env: env() });
    const r = await upload(t);
    expect(r.decision).toBe('ALLOW');
    const before = mock.payoutCalls().length;
    const out = await executePayment(t.ctx, finance(t), r.id, r.decisionId);
    expect(out.status).toBe('CAPTURE_PENDING');
    expect(mock.payoutCalls().length).toBe(before + 1);
    const call = mock.payoutCalls().at(-1)!;
    const sent = JSON.parse(call.body);
    expect(sent.items[0].receiver).toBe(RECEIVER);
    expect(sent.items[0].amount).toEqual({ value: '1296.00', currency: 'USD' });
    expect(call.headers['paypal-request-id']).toBe(sent.sender_batch_header.sender_batch_id);
    expect((t.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(r.id) as any).status).toBe('PAYMENT_PENDING');
    const synced = await syncAttempt(t.ctx, out.attemptId);
    expect(synced.status).toBe('COMPLETED');
    expect(synced.confirmed_by).toBe('Authenticated PayPal API lookup');
    await expect(executePayment(t.ctx, finance(t), r.id, r.decisionId)).rejects.toBeInstanceOf(GateRefused);
    expect(mock.payoutCalls().length).toBe(before + 1);
    expect(verifyChain(t.db, t.s.ws).ok).toBe(true);
  });

  it('refuses every bypass attempt without contacting the provider', async () => {
    const t = await setup({ env: env() });
    const before = mock.calls.length;
    const out = await bypassSuite({ ctx: t.ctx, s: t.s });
    expect(out.actual).toBe('ALL_REFUSED');
    expect(out.note).not.toContain('EXECUTED');
    for (const code of ['NO_DECISION', 'DECISION_EXPIRED', 'DECISION_DENIED', 'DECISION_HELD', 'TRANSACTION_CHANGED', 'WRONG_WORKSPACE', 'ROLE_NOT_PERMITTED']) expect(out.note).toContain(code);
    expect(mock.calls.slice(before).filter((c) => c.path.startsWith('/v1/payments'))).toEqual([]);
  });

  it('held and denied requests never reach the rail, even with a forged gate pass', async () => {
    const t = await setup({ env: env() });
    const held = await upload(t, northwindInvoice(ATTACKER_PAYPAL, { number: 'INV-HELD' }));
    expect(held.decision).toBe('HOLD');
    await expect(executePayment(t.ctx, finance(t), held.id, held.decisionId)).rejects.toMatchObject({ code: 'DECISION_HELD' });
    const rail = createPayPal(loadConfig({ ...env(), NODE_ENV: 'test' }));
    await expect(rail.createPayout({ attemptId: 'x', requestId: held.id } as any, { idempotencyKey: 'k', receiverEmail: ATTACKER_PAYPAL, amountMinor: 1, currency: 'USD', note: '' })).rejects.toThrow(/no gate pass/);
  });

  it('a concurrent double release produces one payment', async () => {
    const t = await setup({ env: env() });
    const r = await upload(t);
    const before = mock.payoutCalls().length;
    const results = await Promise.allSettled([executePayment(t.ctx, finance(t), r.id, r.decisionId), executePayment(t.ctx, finance(t), r.id, r.decisionId)]);
    expect(results.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(mock.payoutCalls().length).toBe(before + 1);
  });

  it('records a provider outage as unknown, never as success', async () => {
    const t = await setup({ env: env() });
    const r = await upload(t);
    mock.state.failPayout = 503;
    const out = await executePayment(t.ctx, finance(t), r.id, r.decisionId);
    mock.state.failPayout = null;
    expect(out.status).toBe('UNKNOWN');
    expect((t.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(r.id) as any).status).toBe('PAYMENT_PENDING');
  });

  it('refuses a live PayPal base URL', () => {
    expect(() => createPayPal(loadConfig({ PAYPAL_BASE_URL: 'https://api-m.paypal.com' }))).toThrow(/sandbox/);
  });
});

describe('webhooks', () => {
  const headers = (sig: string) => ({ 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': sig, 'paypal-transmission-time': new Date().toISOString() });
  it('rejects forged events and applies a verified one exactly once', async () => {
    const t = await setup({ env: env() });
    const r = await upload(t);
    mock.state.payoutItemStatus = 'PENDING';
    const out = await executePayment(t.ctx, finance(t), r.id, r.decisionId);
    const attempt = t.db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(out.attemptId) as any;
    const body = JSON.stringify({ id: 'WH-EVT-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_batch_id: attempt.provider_ref, payout_item_id: 'I1' } });
    expect((await handleWebhook(t.ctx, headers('forged'), body, sha256(body))).accepted).toBe(false);
    expect((t.db.prepare('SELECT status FROM payment_attempts WHERE id = ?').get(out.attemptId) as any).status).toBe('CAPTURE_PENDING');
    expect((await handleWebhook(t.ctx, headers('valid-signature'), body, sha256(body))).accepted).toBe(true);
    const done = t.db.prepare('SELECT status, confirmed_by FROM payment_attempts WHERE id = ?').get(out.attemptId) as any;
    expect(done).toEqual({ status: 'COMPLETED', confirmed_by: 'Verified PayPal webhook' });
    const dup = await handleWebhook(t.ctx, headers('valid-signature'), body, sha256(body));
    expect(dup).toMatchObject({ accepted: true, duplicate: true });
    expect((t.db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE event_type = 'PAYMENT_CONFIRMED' AND payment_request_id = ?`).get(r.id) as any).c).toBe(1);
    mock.state.payoutItemStatus = 'SUCCESS';
  });
  it('rejects everything when no webhook id is configured', async () => {
    const t = await setup({ env: { ...env(), PAYPAL_WEBHOOK_ID: '' } });
    const body = JSON.stringify({ id: 'X', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} });
    expect((await handleWebhook(t.ctx, headers('valid-signature'), body, sha256(body))).accepted).toBe(false);
  });
});

describe('architecture', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
  it('only the executor imports the PayPal rail, and AI code imports neither', () => {
    for (const f of files('server/src')) {
      const src = readFileSync(f, 'utf8');
      if (/from\s+['"][^'"]*paypal\.js['"]/.test(src) && !f.includes('server/src/executor/') && !f.endsWith('server/src/app.ts')) throw new Error(`${f} imports the PayPal rail`);
      if (f.includes('/ai/') || f.includes('/ingest/') || f.includes('/evidence/') || f.includes('/agents/authority')) expect(src, f).not.toMatch(/executor\/|PAYPAL_CLIENT/);
    }
  });
  it('app.ts uses the rail only to build it and check health', () => {
    const src = readFileSync('server/src/app.ts', 'utf8');
    expect(src).not.toMatch(/paypal\.(createPayout|createOrder|captureOrder)/);
  });
});
