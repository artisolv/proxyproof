import { one, run, type DB } from './db/index.js';
import { newId, nowIso } from './core/util.js';
import { appendAudit } from './core/ledger.js';
import { approveDelegation, createPrincipal, registerAgent, requestDelegation, revokeDelegation } from './trust/registry.js';

/** What the demo seller offers. Prices in minor units (USD cents). */
export const CATALOG = [
  { name: 'House Blend, 5 lb', category: 'coffee', unit_amount_minor: 6_800 },
  { name: 'Ethiopia Guji, 2 lb', category: 'coffee', unit_amount_minor: 4_200 },
  { name: 'Burr grinder', category: 'equipment', unit_amount_minor: 18_900 },
  { name: 'Espresso machine', category: 'equipment', unit_amount_minor: 129_900 },
  { name: 'Espresso machine service visit', category: 'service', unit_amount_minor: 24_000 },
  { name: 'Barista training, half day', category: 'service', unit_amount_minor: 35_000 },
];

export function createWorkspace(db: DB, name: string, userName: string) {
  const ws = newId('ws'), user = newId('usr');
  run(db, 'INSERT INTO users (id, email, name, created_at) VALUES (?,?,?,?)', user, `${user}@demo.proxyproof.local`, userName, nowIso());
  run(db, 'INSERT INTO workspaces (id, name, created_at) VALUES (?,?,?)', ws, name, nowIso());
  run(db, 'INSERT INTO workspace_members (workspace_id, user_id) VALUES (?,?)', ws, user);
  appendAudit(db, ws, 'WORKSPACE_CREATED', { type: 'USER', id: user }, null, { name });
  return { ws, user };
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
/** How demo organizations were "verified": disclosed plainly, never presented as legal or KYB verification. */
export const DEMO_ENROLLMENT = 'demo enrollment: created by the hackathon’s controlled onboarding, no legal or KYB check';

/**
 * Two independent sides of commerce, each with its own organization key. Every agent below is registered and authorized
 * through the same registry functions the dashboard and the public API use, so each state is real, not a label.
 */
export async function seedDemo(db: DB, opts: { publicUrl: string; buyerEmail: string; sellerAccount: string }) {
  const { ws, user } = createWorkspace(db, 'ProxyProof demo', 'Demo administrator');
  const me = { id: user, name: 'Demo administrator' };
  const sys = { type: 'SYSTEM' as const };

  const northwind = createPrincipal(db, ws, { name: 'Northwind Hotels', role: 'BUYER', verified: true, method: DEMO_ENROLLMENT, paymentAccount: opts.buyerEmail });
  const crescent = createPrincipal(db, ws, { name: 'Crescent Retail', role: 'BUYER', verified: false, paymentAccount: null });
  const harbor = createPrincipal(db, ws, { name: 'Harbor & Pine Roasters', role: 'SELLER', verified: true, method: DEMO_ENROLLMENT, paymentAccount: opts.sellerAccount });
  const bayside = createPrincipal(db, ws, { name: 'Bayside Trading Co.', role: 'SELLER', verified: false, paymentAccount: 'payments@bayside.example' });
  const did = (id: string) => one<any>(db, 'SELECT did FROM principals WHERE id = ?', id).did;

  const buy = { actions: ['purchase'], max_amount_minor: 50_000, currencies: ['USD'], categories: ['coffee', 'equipment'], counterparties: [did(harbor)], step_up_above_minor: 25_000 };
  const sell = { actions: ['quote', 'issue_invoice', 'request_payment'], max_amount_minor: 200_000, currencies: ['USD'], categories: ['coffee', 'equipment', 'service'], counterparties: [did(northwind), did(crescent)], destinations: [opts.sellerAccount] };

  const make = async (name: string, side: 'BUYER' | 'SELLER', org: string, mandate: any | null, how: 'active' | 'none' | 'expired' | 'revoked' = 'active') => {
    const { id } = await registerAgent(db, ws, { name, side, principalId: org, provider: 'ProxyProof test agent' }, sys);
    if (!mandate || how === 'none') return id;
    const window = how === 'expired' ? { validFrom: days(-40), validUntil: days(-10) } : { validUntil: days(30) };
    const d = requestDelegation(db, ws, id, { mandate, ...window }, sys);
    await approveDelegation(db, ws, d, me, opts.publicUrl);
    if (how === 'revoked') revokeDelegation(db, ws, d, user, `${one<any>(db, 'SELECT name FROM principals WHERE id = ?', org).name} revoked this agent`);
    return id;
  };

  // Buyer side (verified by the seller: "may this agent MAKE payment?")
  await make('Northwind Procurement Agent', 'BUYER', northwind, { ...buy, may_delegate: true });
  await make('Northwind Research Agent', 'BUYER', northwind, { ...buy, actions: ['research'] });
  await make('Northwind Events Agent', 'BUYER', northwind, buy, 'expired');
  await make('Northwind Ops Agent', 'BUYER', northwind, buy, 'revoked');
  await make('Crescent Buying Agent', 'BUYER', crescent, { ...buy, counterparties: [did(harbor)] });
  // Seller side (verified by the buyer: "may this agent COLLECT payment?")
  await make('Harbor & Pine Sales Agent', 'SELLER', harbor, sell);
  await make('Harbor & Pine Support Agent', 'SELLER', harbor, { ...sell, actions: ['quote'] });
  await make('Harbor & Pine Seasonal Agent', 'SELLER', harbor, sell, 'expired');
  await make('Harbor & Pine Legacy Agent', 'SELLER', harbor, sell, 'revoked');
  await make('Bayside Sales Agent', 'SELLER', bayside, { ...sell, destinations: ['payments@bayside.example'] });
  return { ws, user, orgs: { northwind, crescent, harbor, bayside } };
}
