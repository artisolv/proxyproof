import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { noModel, type ModelProvider } from '../src/ai/model.js';
import type { PublicEvidenceProvider } from '../src/evidence/public.js';
import { seedWorkspace } from '../src/seed.js';

export const offline: PublicEvidenceProvider = async (domain) => ({ domain, reservedTestDomain: true, available: true, errors: [], hasMx: null, hasDmarc: null, registeredAt: null, ageDays: null, homepage: null });
export const RECEIVER = 'receiver@personal.example.com';

export async function setup(opts: { model?: ModelProvider; publicEvidence?: PublicEvidenceProvider; env?: Record<string, string> } = {}) {
  const db = openDb(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_EVIDENCE: 'off', PAYPAL_SANDBOX_RECEIVER_EMAIL: RECEIVER, ...opts.env });
  const { app, ctx } = createApp({ db, config, model: opts.model ?? noModel, publicEvidence: opts.publicEvidence ?? offline });
  const s = await seedWorkspace(db, { name: 'Test', kind: 'DEMO', receiverEmail: RECEIVER });
  return { db, config, app, ctx, s };
}
