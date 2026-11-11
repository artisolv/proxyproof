import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { createPayPal } from '../src/executor/paypal.js';

export const BUYER_EMAIL = 'buyer@personal.example.com';
export const SELLER_ACCOUNT = 'merchant@business.example.com';
const H = { 'x-proxyproof': '1', 'content-type': 'application/json' };

/** A fresh in-memory server with a seeded demo workspace and a signed-in dashboard session. */
export async function setup(env: Record<string, string> = {}) {
  const db = openDb(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', PAYPAL_SANDBOX_RECEIVER_EMAIL: BUYER_EMAIL, PAYPAL_SANDBOX_MERCHANT_EMAIL: SELLER_ACCOUNT, ...env });
  const { app, ctx } = createApp({ db, config, paypal: createPayPal(config) });
  const res = await app.request('/api/demo/start', { method: 'POST', headers: H });
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const { workspaceId: ws } = (await res.json()) as any;
  const get = async (p: string) => (await app.request(p, { headers: { ...H, cookie } })).json() as Promise<any>;
  const post = async (p: string, body: unknown = {}) => { const r = await app.request(p, { method: 'POST', headers: { ...H, cookie }, body: JSON.stringify(body) }); return { status: r.status, json: (await r.json()) as any }; };
  const state = () => get('/api/state');
  const agent = async (name: string) => (await state()).agents.find((a: any) => a.name === name);
  const org = async (name: string) => (await state()).organizations.find((p: any) => p.name === name);
  const items = async (list: [string, number][]) => { const st = await state(); return list.map(([n, q]) => { const p = st.catalog.find((c: any) => c.name === n); return { name: p.name, category: p.category, quantity: q, unit_amount_minor: p.unit_amount_minor }; }); };

  /** Seller's agent sends an offer through the public API, exactly as the dashboard drives it. */
  const offer = async (agentName: string, buyerName: string, list: [string, number][], o: { behaviour?: string; document?: 'QUOTE' | 'INVOICE'; pay_to?: string; transaction_id?: string; expires_in_s?: number } = {}) => {
    const a = await agent(agentName), b = await org(buyerName);
    const r = await post('/api/runtime/offer', { agent_id: a.id, buyer_org_id: b.id, behaviour: o.behaviour ?? 'honest', transaction_id: o.transaction_id, draft: { reference: `INV-${Math.floor(Math.random() * 1e6)}`, document: o.document ?? 'INVOICE', currency: 'USD', items: await items(list), payment_destination: o.pay_to ?? SELLER_ACCOUNT, expires_in_s: o.expires_in_s } });
    return r.json;
  };
  /** Buyer's agent reads the terms from ProxyProof and signs an acceptance. */
  const accept = async (agentName: string, txId: string, behaviour = 'honest') => (await post('/api/runtime/accept', { agent_id: (await agent(agentName)).id, transaction_id: txId, behaviour })).json;
  const execute = async (txId: string, permit?: string) => { const r = await app.request(`/api/v1/workspaces/${ws}/transactions/${txId}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permit }) }); return { status: r.status, json: (await r.json()) as any }; };
  /** The standard valid pair: a $136 coffee invoice, accepted by the procurement agent. */
  const validPair = async (list: [string, number][] = [['House Blend, 5 lb', 2]]) => {
    const o = await offer('Harbor & Pine Sales Agent', 'Northwind Hotels', list);
    const a = await accept('Northwind Procurement Agent', o.transaction_id);
    return { o, a, id: o.transaction_id as string };
  };
  return { db, config, app, ctx, ws, cookie, get, post, state, agent, org, items, offer, accept, execute, validPair };
}
export const codes = (r: any) => (r.reasons ?? []).map((x: any) => x.code);
export const failCodes = (r: any) => (r.reasons ?? []).filter((x: any) => x.state === 'fail').map((x: any) => x.code);
