import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { startMockPayPal } from './mockPaypal.js';
import { COMPLICATIONS, PROMPTS, compose } from '../src/scenarios/catalog.js';

/**
 * The scenario engine plays every request × complication through the real verification. These tests pin the outcome
 * each combination's conditions must produce, so a regression in the trust layer shows up as a changed decision, not a
 * silent pass. (The engine itself never looks at what a run "should" do: these expectations live only here.)
 */
let mock: Awaited<ReturnType<typeof startMockPayPal>> | null = null;
afterEach(async () => { await mock?.close(); mock = null; });
const live = async () => { mock = await startMockPayPal(); return setup({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_BASE_URL: mock.url }); };

/** First place ProxyProof intervened, and where it finally stopped the run (null: the payment went ahead). */
function expected(prompt: string, complication: string): { first: string | null; final: string | null } {
  const bill = prompt === 'pay-bill'; // $476: above Northwind's $250 approval line
  switch (complication) {
    case 'genuine': case 'wrong-item': return { first: bill ? 'REVIEW_REQUIRED' : null, final: null };
    case 'payout-changed': return { first: 'DESTINATION_NOT_AUTHORIZED', final: 'DESTINATION_NOT_AUTHORIZED' };
    case 'altered-in-transit': return { first: 'TERMS_MODIFIED', final: 'TERMS_MODIFIED' };
    case 'different-totals': return { first: 'TERMS_MISMATCH', final: 'TERMS_MISMATCH' };
    case 'forged-mandate': return { first: 'DELEGATION_FORGED', final: 'DELEGATION_FORGED' };
    case 'lookalike-supplier': return { first: 'ORG_NOT_ESTABLISHED', final: 'COUNTERPARTY_NOT_APPROVED' };
    case 'prompt-injection': return { first: 'CATEGORY_NOT_PERMITTED', final: 'CATEGORY_NOT_PERMITTED' };
    case 'revoked-agent': return { first: bill ? 'REVIEW_REQUIRED' : 'LIVE_RECHECK_FAILED', final: 'LIVE_RECHECK_FAILED' };
    case 'duplicate-payment': return { first: bill ? 'REVIEW_REQUIRED' : 'PERMIT_ALREADY_USED', final: 'PERMIT_ALREADY_USED' };
    case 'status-outage': return { first: 'STATUS_UNAVAILABLE', final: null };
  }
  throw new Error(`No expectation for ${complication}`);
}

describe('scenario engine', () => {
  it('lists requests and complications without outcomes', async () => {
    const t = await setup();
    const r = await t.get('/api/lab/scenarios');
    expect(r.prompts.length).toBe(PROMPTS.length);
    expect(r.complications.length).toBe(COMPLICATIONS.length);
    expect(JSON.stringify(r)).not.toMatch(/"(decision|expected)"/);
  });

  for (const p of PROMPTS) for (const c of COMPLICATIONS) {
    if (!compose(p.id, c.id)) continue;
    it(`${p.prompt} × ${c.title}`, async () => {
      const t = await live();
      const res = await t.post('/api/lab/runs', { prompt: p.id, complication: c.id });
      expect(res.status).toBe(201);
      let run = res.json;
      const exp = expected(p.id, c.id);
      // A run that needs a person's approval genuinely waits; the presenter's click performs the signed approval.
      if (exp.first === 'REVIEW_REQUIRED') expect(run.awaiting).toBeTruthy();
      let guard = 0;
      while (run.awaiting && guard++ < 3) { const r = await t.post(`/api/lab/runs/${run.id}/approve`); expect(r.status).toBe(200); run = r.json; }
      expect(run.finished).toBe(true);
      expect(JSON.stringify(run)).not.toContain('"_state"');
      expect(run.outcome.stops[0]?.code ?? null).toBe(exp.first);
      expect(run.outcome.caught_at?.code ?? null).toBe(exp.final);
      // Money only moves toward PayPal when nothing stopped the run; a stopped run never reaches the provider.
      if (exp.final === null) expect(run.outcome.payment_state).toBe('AWAITING_BUYER_APPROVAL');
      if (exp.final && !['PERMIT_ALREADY_USED'].includes(exp.final)) expect(run.outcome.payment_state).toBe('NOT_STARTED');
      expect(run.workspace_id).not.toBe(t.ws);
    });
  }

  it('refuses combinations that do not apply', async () => {
    const t = await setup();
    expect((await t.post('/api/lab/runs', { prompt: 'pay-bill', complication: 'wrong-item' })).status).toBe(404);
  });

  it('keeps runs private to the workspace that started them', async () => {
    const a = await setup();
    const run = (await a.post('/api/lab/runs', { prompt: 'buy-coffee', complication: 'genuine' })).json;
    const b = await setup();
    const r = await b.app.request(`/api/lab/runs/${run.id}`, { headers: { 'x-proxyproof': '1', cookie: b.cookie } });
    expect(r.status).toBe(404);
  });
});
