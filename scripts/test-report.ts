/**
 * Builds docs/testing/test-report.json from an actual vitest run plus a latency measurement.
 * Usage: npm run test:report. Every number comes from this run; nothing is estimated.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db/index.js';
import { createApp } from '../server/src/app.js';

const raw = JSON.parse(readFileSync('docs/testing/vitest-results.json', 'utf8'));
const tests: { name: string; status: string; ms: number }[] = raw.testResults.flatMap((f: any) => f.assertionResults.map((a: any) => ({ name: [...a.ancestorTitles, a.title].join(' › '), status: a.status, ms: Math.round(a.duration ?? 0) })));
const PROPERTIES: [string, RegExp][] = [
  ['Valid bilateral transaction allowed', /both sides valid|independently developed agent|bilateral transaction/i],
  ['Seller authority failures rejected', /seller agent not authorized|seller signature|wrong payment destination|expired and revoked|unverified organizations/i],
  ['Buyer scope and authority failures rejected', /buyer over its limit|same owner|different terms|expired and revoked/i],
  ['Invalid signatures, forged or self-issued authority', /invalid seller signature|private key/i],
  ['Transaction mutation and term changes', /terms changed|different terms|tamper/i],
  ['Replay and duplicate execution', /replay|single use|concurrent/i],
  ['Revocation and expiry enforced, including at time of use', /revok|expired/i],
  ['Fail closed when a dependency is unavailable', /dependency unavailable/i],
  ['Direct executor bypass attempts', /bypass|permit for another|without a valid/i],
  ['Payment completion only on provider confirmation', /COMPLETED only|unverified webhooks/i],
  ['Evidence bundle integrity', /evidence bundle/i],
  ['MCP connector authentication and scope', /MCP connector|connection token|foreign browser|buyer tools/i],
  ['Architecture boundaries', /architecture|only the executor|cannot reach/i],
];
const properties = PROPERTIES.map(([name, re]) => { const m = tests.filter((t) => re.test(t.name)); return { name, tests: m.length, failed: m.filter((t) => t.status !== 'passed').length }; });

// Latency: offer + acceptance through the public API (both sides verified and matched), in-process, fresh database.
const db = openDb(':memory:');
const config = loadConfig({ NODE_ENV: 'test', PAYPAL_SANDBOX_MERCHANT_EMAIL: 'merchant@business.example.com' });
const { app } = createApp({ db, config });
const H = { 'x-proxyproof': '1', 'content-type': 'application/json' };
const start = await app.request('/api/demo/start', { method: 'POST', headers: H });
const cookie = start.headers.get('set-cookie')!.split(';')[0];
const st: any = await (await app.request('/api/state', { headers: { ...H, cookie } })).json();
const id = (n: string) => st.agents.find((a: any) => a.name === n).id;
const buyer = st.organizations.find((o: any) => o.name === 'Northwind Hotels').id;
const post = async (p: string, b: unknown) => (await app.request(p, { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify(b) })).json() as any;
const samples: number[] = [];
for (let i = 0; i < 40; i++) {
  const t0 = performance.now();
  const o = await post('/api/runtime/offer', { agent_id: id('Harbor & Pine Sales Agent'), buyer_org_id: buyer, draft: { reference: `B-${i}`, document: 'INVOICE', currency: 'USD', items: [{ name: 'House Blend, 5 lb', category: 'coffee', quantity: 1, unit_amount_minor: 6800 }], payment_destination: 'merchant@business.example.com' } });
  const a = await post('/api/runtime/accept', { agent_id: id('Northwind Procurement Agent'), transaction_id: o.transaction_id });
  if (a.decision !== 'ALLOW') throw new Error(`benchmark transaction not allowed: ${a.decision}`);
  samples.push(performance.now() - t0);
}
samples.sort((x, y) => x - y);
const pct = (p: number) => Math.round(samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))] * 10) / 10;

const report = {
  generated_at: new Date().toISOString(),
  environment: `Node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus()[0]?.model ?? 'CPU'}, in-memory SQLite, PayPal mocked on loopback`,
  total: tests.length, passed: tests.filter((t) => t.status === 'passed').length, failed: tests.filter((t) => t.status !== 'passed').length,
  properties, tests,
  latency: { samples: samples.length, what: 'seller offer + buyer acceptance via the public API, including signing, both-side verification and matching', p50_ms: pct(50), p95_ms: pct(95) },
};
writeFileSync('docs/testing/test-report.json', JSON.stringify(report, null, 2));
console.log(`${report.passed}/${report.total} passed; latency p50 ${report.latency.p50_ms} ms, p95 ${report.latency.p95_ms} ms`);
