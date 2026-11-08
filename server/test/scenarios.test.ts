import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';
import { SCENARIOS, runScenario } from '../src/challenge/scenarios.js';

describe('Security Challenge pack', () => {
  it('every seeded scenario lands on its published expected outcome', async () => {
    const { ctx, s } = await setup();
    const results = [];
    for (const sc of SCENARIOS.filter((x) => !x.live)) results.push({ ...(await runScenario(ctx, s.ws, 'test', sc, 'receiver@personal.example.com')), title: sc.title, expected: sc.expectedLabel });
    const failed = results.filter((r) => r.passed !== 1);
    if (failed.length) console.log(JSON.stringify(failed, null, 2));
    expect(failed).toEqual([]);
  }, 120_000);
});

describe('scenario reasons are the specific, explainable checks', () => {
  it('fires the expected rule codes', async () => {
    const { ctx, s, db } = await setup();
    const want: Record<string, string[]> = { T02: ['DESTINATION_MISMATCH'], T03: ['SENDER_LOOKALIKE_DOMAIN'], T04: ['DUPLICATE_FILE'], T05: ['DUPLICATE_INVOICE_NUMBER'], T06: ['AUTH_AMOUNT_EXCEEDED'], T07: ['AUTH_VENDOR_OUT_OF_SCOPE'], T08: ['AUTH_EXPIRED'], T09: ['AGENT_REVOKED'], T10: ['EMBEDDED_INSTRUCTIONS'], T11: ['TOTALS_INCONSISTENT'], T12: ['VENDOR_UNKNOWN'], T14: ['ALREADY_PAID'], T16: ['VERIFICATION_UNAVAILABLE'], T19: ['DESTINATION_MISMATCH'], T20: ['AMOUNT_UNUSUAL'], H01: ['EMBEDDED_INSTRUCTIONS', 'DESTINATION_MISMATCH'], H02: ['DESTINATION_MISMATCH'], H03: ['AGENT_SIGNATURE_INVALID'], H04: ['AUTH_FORGED'], H05: ['AGENT_REPLAY'], H06: ['AMOUNT_DIFFERS_FROM_INVOICE'], H07: ['REPLY_TO_MISMATCH'], H08: ['FILE_REJECTED'] };
    const { SCENARIOS: list } = await import('../src/challenge/scenarios.js');
    const report: Record<string, string[]> = {};
    for (const sc of list.filter((x) => want[x.id])) {
      const r = await runScenario(ctx, s.ws, 'codes', sc);
      const row = db.prepare('SELECT payment_request_id FROM challenge_runs WHERE id = ?').get(r.id) as any;
      const d = db.prepare('SELECT reasons FROM policy_decisions WHERE payment_request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(row.payment_request_id) as any;
      report[sc.id] = JSON.parse(d.reasons).reasons.map((x: any) => x.code);
    }
    for (const [id, codes] of Object.entries(want)) for (const code of codes) expect(report[id], `${id}: ${report[id]}`).toContain(code);
    // Legitimate scenarios fire nothing at all.
  }, 120_000);
});
