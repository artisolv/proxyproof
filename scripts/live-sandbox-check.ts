// Runs the full pipeline against the real PayPal sandbox: a permitted invoice is paid, a held one is refused.
// Run: node --env-file=.env --import tsx scripts/live-sandbox-check.ts
import { loadConfig } from '../server/src/config.js';
import { openDb } from '../server/src/db/index.js';
import { createApp } from '../server/src/app.js';
import { SCENARIOS, runScenario } from '../server/src/challenge/scenarios.js';
import { seedWorkspace } from '../server/src/seed.js';

const config = loadConfig({ ...process.env, NODE_ENV: 'test', PUBLIC_EVIDENCE: 'off' });
if (config.PAYPAL_BASE_URL) throw new Error('Unset PAYPAL_BASE_URL to use the sandbox.');
const db = openDb(':memory:');
const { ctx } = createApp({ db, config });
const parent = await seedWorkspace(db, { name: 'Live check', kind: 'DEMO', receiverEmail: config.PAYPAL_SANDBOX_RECEIVER_EMAIL });
for (const id of ['T18', 'T02', 'H09']) {
  const r = await runScenario(ctx, parent.ws, 'live', SCENARIOS.find((s) => s.id === id)!, config.PAYPAL_SANDBOX_RECEIVER_EMAIL);
  const row: any = db.prepare('SELECT * FROM challenge_runs WHERE id = ?').get(r.id);
  console.log(`${id}: ${r.actual} passed=${r.passed} executor_called=${row.executor_called} ${r.note ?? ''}`);
  if (id === 'T18') {
    const a: any = db.prepare(`SELECT status, provider_ref, provider_status, confirmed_by, amount_minor, currency FROM payment_attempts WHERE workspace_id = ? AND provider = 'PAYPAL_SANDBOX'`).get(row.sandbox_workspace_id);
    console.log('  attempt:', JSON.stringify(a));
  }
}
