import { run, one, type DB } from './db/index.js';
import { destinationFingerprint, newId, normalizeInvoiceNumber, normalizeName, nowIso, sha256 } from './core/util.js';
import { appendAudit } from './core/ledger.js';
import { DEFAULT_RULES, type PolicyRules } from './policy/engine.js';
import { issueGrant, newAgentKeys } from './agents/authority.js';
import { ATLAS, MERIDIAN, NORTHWIND } from './challenge/fixtures.js';

export const defaultReceiver = (email?: string) => email ?? 'billing@northwind-cloud.example';

export function createWorkspace(db: DB, name: string, kind: 'STANDARD' | 'DEMO' | 'CHALLENGE', ownerId: string, parentId?: string) {
  const id = newId('ws'), now = nowIso();
  run(db, 'INSERT INTO workspaces (id, name, kind, parent_id, created_at) VALUES (?,?,?,?,?)', id, name, kind, parentId ?? null, now);
  run(db, `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?, 'OWNER')`, id, ownerId);
  const policyId = newId('pol');
  run(db, 'INSERT INTO policies (id, workspace_id, current_version) VALUES (?,?,1)', policyId, id);
  run(db, 'INSERT INTO policy_versions (policy_id, workspace_id, version, rules, note, created_by, created_at) VALUES (?,?,1,?,?,?,?)', policyId, id, JSON.stringify(DEFAULT_RULES), 'Default policy', ownerId, now);
  appendAudit(db, id, 'WORKSPACE_CREATED', { type: 'USER', id: ownerId }, null, { name, kind });
  return id;
}

export function setPolicy(db: DB, ws: string, rules: PolicyRules, by: string, note?: string) {
  const p = one<any>(db, 'SELECT * FROM policies WHERE workspace_id = ?', ws)!;
  const version = p.current_version + 1;
  run(db, 'INSERT INTO policy_versions (policy_id, workspace_id, version, rules, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)', p.id, ws, version, JSON.stringify(rules), note ?? null, by, nowIso());
  run(db, 'UPDATE policies SET current_version = ? WHERE id = ?', version, p.id);
  appendAudit(db, ws, 'POLICY_CHANGED', { type: 'USER', id: by }, null, { version, note: note ?? null });
  return version;
}

export function addVendor(db: DB, ws: string, v: { name: string; domains?: string[]; country?: string; businessId?: string; currencies?: string[]; categories?: string[]; status?: string }, by: string) {
  const id = newId('ven');
  run(db, `INSERT INTO vendors (id, workspace_id, name, normalized_name, country, business_id, domains, currencies, categories, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, ws, v.name, normalizeName(v.name), v.country ?? null, v.businessId ?? null, JSON.stringify((v.domains ?? []).map((d) => d.toLowerCase())), JSON.stringify(v.currencies ?? ['USD']), JSON.stringify(v.categories ?? []), v.status ?? 'PENDING', by, nowIso());
  appendAudit(db, ws, 'VENDOR_CREATED', { type: 'USER', id: by }, null, { vendor_id: id, name: v.name, status: v.status ?? 'PENDING' });
  return id;
}
export function addDestination(db: DB, ws: string, vendorId: string, d: { type: string; value: string; method: string }, by: string) {
  const id = newId('dst'), value = d.type === 'PAYPAL_EMAIL' ? d.value.trim().toLowerCase() : d.value.trim();
  run(db, `INSERT INTO vendor_destinations (id, workspace_id, vendor_id, type, value, fingerprint, status, verified_by, verified_at, verification_method) VALUES (?,?,?,?,?,?, 'VERIFIED', ?,?,?)
           ON CONFLICT (vendor_id, fingerprint) DO UPDATE SET status = 'VERIFIED', verified_by = excluded.verified_by, verified_at = excluded.verified_at, verification_method = excluded.verification_method`,
    id, ws, vendorId, d.type, value, destinationFingerprint(d.type, value), by, nowIso(), d.method);
  run(db, 'INSERT INTO vendor_verifications (id, workspace_id, vendor_id, kind, method, notes, verified_by, created_at) VALUES (?,?,?,?,?,?,?,?)', newId('ver'), ws, vendorId, 'DESTINATION', d.method, `${d.type} added`, by, nowIso());
  appendAudit(db, ws, 'DESTINATION_VERIFIED', { type: 'USER', id: by }, null, { vendor_id: vendorId, type: d.type, method: d.method });
}

function history(db: DB, ws: string, vendorId: string, vendorName: string, number: string, totalMinor: number, monthsAgo: number) {
  const inv = newId('inv'), when = new Date(Date.now() - monthsAgo * 30 * 86_400_000).toISOString();
  run(db, `INSERT INTO invoices (id, workspace_id, vendor_id, vendor_name, number, normalized_number, currency, total_minor, semantic_fingerprint, is_seed_history, created_at) VALUES (?,?,?,?,?,?, 'USD', ?, ?, 1, ?)`,
    inv, ws, vendorId, vendorName, number, normalizeInvoiceNumber(number), totalMinor, sha256(`seed:${vendorId}:${number}`), when);
  run(db, `INSERT INTO payment_attempts (id, workspace_id, payment_key, rail, invoice_id, status, provider, idempotency_key, vendor_id, amount_minor, currency, confirmed_by, created_at, updated_at) VALUES (?,?,?, 'PAYOUTS', ?, 'COMPLETED', 'SEED_HISTORY', ?,?,?, 'USD', 'Seeded demo history', ?, ?)`,
    newId('pay'), ws, sha256(`seed-key:${inv}`), inv, `seed-${inv}`, vendorId, totalMinor, when, when);
}

export type Seeded = { ws: string; owner: string; finance: string; reviewer: string; auditor: string; northwind: string; meridian: string; atlas: string; procurementAgent: string; receiver: string };

/** Fills a workspace with fictional vendors, history, and agents. All records use reserved domains. */
export async function seedWorkspace(db: DB, opts: { name: string; kind: 'DEMO' | 'CHALLENGE'; receiverEmail?: string; parentId?: string }): Promise<Seeded> {
  const unique = newId('u').toLowerCase();
  const user = (name: string, tag: string) => { const id = newId('usr'); run(db, 'INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)', id, `${tag}.${unique}@demo.payeeproof.test`, name, nowIso()); return id; };
  const owner = user('Morgan Lee', 'owner'), finance = user('Priya Raman', 'finance'), reviewer = user('Sam Ortiz', 'reviewer'), auditor = user('Dana Wu', 'auditor');
  const ws = createWorkspace(db, opts.name, opts.kind, owner, opts.parentId);
  for (const [id, role] of [[finance, 'FINANCE_ADMIN'], [reviewer, 'REVIEWER'], [auditor, 'AUDITOR']]) run(db, 'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)', ws, id, role);

  const receiver = defaultReceiver(opts.receiverEmail);
  const method = 'Confirmed by phone using the number on the signed contract';
  const northwind = addVendor(db, ws, { name: NORTHWIND.name, domains: [NORTHWIND.domain], country: 'US', businessId: 'EIN 91-0000001', categories: ['hosting', 'software'], status: 'VERIFIED' }, owner);
  addDestination(db, ws, northwind, { type: 'PAYPAL_EMAIL', value: receiver, method }, owner);
  run(db, 'INSERT INTO vendor_contacts (id, workspace_id, vendor_id, email, name, verification_method, verified_at) VALUES (?,?,?,?,?,?,?)', newId('con'), ws, northwind, `billing@${NORTHWIND.domain}`, 'Northwind billing', method, nowIso());
  const meridian = addVendor(db, ws, { name: MERIDIAN.name, domains: [MERIDIAN.domain], country: 'US', categories: ['office'], status: 'VERIFIED' }, owner);
  addDestination(db, ws, meridian, { type: 'PAYPAL_EMAIL', value: MERIDIAN.paypal, method }, owner);
  const atlas = addVendor(db, ws, { name: ATLAS.name, domains: [ATLAS.domain], country: 'US', categories: ['legal'], status: 'VERIFIED' }, owner);
  addDestination(db, ws, atlas, { type: 'PAYPAL_EMAIL', value: ATLAS.paypal, method }, owner);
  history(db, ws, northwind, NORTHWIND.name, 'INV-1998', 124000, 3); history(db, ws, northwind, NORTHWIND.name, 'INV-2011', 128000, 2); history(db, ws, northwind, NORTHWIND.name, 'INV-2027', 129600, 1);
  history(db, ws, meridian, MERIDIAN.name, 'MOS-5512', 34250, 2);
  history(db, ws, atlas, ATLAS.name, 'AL-301', 90000, 4);

  const keys = newAgentKeys();
  const procurementAgent = addAgent(db, ws, 'Procurement Agent', owner, keys.publicKeyPem, keys.privateKeyPem);
  await issueGrant(db, { workspaceId: ws, agentId: procurementAgent, principalUserId: owner, createdBy: owner, categories: ['hosting', 'software'], vendorIds: [northwind], currencies: ['USD'], perTxMaxMinor: 250000, dailyBudgetMinor: 500000, monthlyBudgetMinor: 2000000, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(), policyVersion: 1 });
  appendAudit(db, ws, 'DEMO_DATA_SEEDED', { type: 'SYSTEM' }, null, { synthetic: true });
  return { ws, owner, finance, reviewer, auditor, northwind, meridian, atlas, procurementAgent, receiver };
}

export function addAgent(db: DB, ws: string, name: string, principal: string, publicKeyPem: string, simulatorPrivateKey?: string) {
  const id = newId('agt');
  run(db, `INSERT INTO agents (id, workspace_id, name, principal_user_id, public_key_pem, status, created_at) VALUES (?,?,?,?,?, 'ACTIVE', ?)`, id, ws, name, principal, publicKeyPem, nowIso());
  if (simulatorPrivateKey) run(db, 'INSERT INTO simulator_agent_keys (agent_id, private_key_pem) VALUES (?,?)', id, simulatorPrivateKey);
  appendAudit(db, ws, 'AGENT_REGISTERED', { type: 'USER', id: principal }, null, { agent_id: id, name });
  return id;
}
