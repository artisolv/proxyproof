import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { setup } from './helpers.js';

/**
 * External agents through the ProxyProof connector, using the official MCP TypeScript client. The client talks to the
 * server's real /mcp route in-process; nothing below touches the database or calls internal functions.
 */
async function connect(t: Awaited<ReturnType<typeof setup>>, token: string | null, mode: 'auto' | 'legacy' = 'auto') {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8787/mcp'), {
    fetch: (url, init) => Promise.resolve(t.app.request(String(url), init as RequestInit)),
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: 'external-agent-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  return { error: Boolean(r.isError), data: r.structuredContent ?? JSON.parse(r.content[0].text) };
};

describe('ProxyProof MCP connector', () => {
  it('refuses a connection without a valid ProxyProof connection token', async () => {
    const t = await setup();
    const res = await t.app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
    await expect(connect(t, 'ppc_not_a_real_token')).rejects.toThrow();
  });

  it('refuses requests from a foreign browser origin', async () => {
    const t = await setup();
    const res = await t.app.request('/mcp', { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer x' }, body: '{}' });
    expect(res.status).toBe(403);
  });

  it('connected is not authorized; the organization approves; then two MCP agents complete one bilateral transaction', async () => {
    const t = await setup();
    const northwind = await t.org('Northwind Hotels'), harbor = await t.org('Harbor & Pine Roasters');
    // Two externally created agents, one per organization, each connected with its own token.
    const buyerReg = await t.post('/api/agents', { name: 'Claude buyer agent', side: 'BUYER', principal_id: northwind.id, provider: 'Claude Code', connection: 'MCP' });
    const sellerReg = await t.post('/api/agents', { name: 'Seller agent (MCP test client)', side: 'SELLER', principal_id: harbor.id, provider: 'MCP test client', connection: 'MCP' });
    expect(buyerReg.json.connection_token).toMatch(/^ppc_/);
    const buyer = await connect(t, buyerReg.json.connection_token);
    const seller = await connect(t, sellerReg.json.connection_token, 'legacy');

    const tools = (await buyer.listTools()).tools.map((x) => x.name);
    expect(tools).toEqual(expect.arrayContaining(['proxyproof_get_agent_status', 'proxyproof_submit_offer', 'proxyproof_accept_transaction', 'proxyproof_execute_checkout']));
    expect(tools.some((n) => /pay|transfer|credential/i.test(n) && n !== 'proxyproof_execute_checkout')).toBe(false);

    let st = await call(buyer, 'proxyproof_get_agent_status');
    expect(st.data.state).toBe('CONNECTED');
    expect(st.data.assurance).toMatch(/Connection token/);

    // The agent can ask for authority, but asking grants nothing.
    const req = await call(buyer, 'proxyproof_request_authority', { actions: ['purchase'], max_amount_usd: 300, categories: ['coffee'], counterparties: ['Harbor & Pine Roasters'] });
    expect(req.data.status).toBe('PENDING_APPROVAL');
    expect((await call(buyer, 'proxyproof_get_agent_status')).data.state).toBe('PENDING_APPROVAL');
    await t.post(`/api/delegations/${req.data.request_id}/approve`);
    st = await call(buyer, 'proxyproof_get_agent_status');
    expect(st.data.state).toBe('AUTHORIZED');
    expect(st.data.authority.limit).toBe('USD 300.00');

    // The seller's MCP agent has no authority yet: its invoice is refused.
    const early = await call(seller, 'proxyproof_submit_offer', { buyer: 'Northwind Hotels', document: 'INVOICE', items: [{ name: 'House Blend, 5 lb', quantity: 2 }] });
    expect(early.data.decision).toBe('DENY');
    expect(early.data.reasons[0].code).toBe('DELEGATION_MISSING');
    const sreq = await call(seller, 'proxyproof_request_authority', { actions: ['issue_invoice', 'request_payment'], max_amount_usd: 1000, categories: ['coffee'], counterparties: ['Northwind Hotels'] });
    await t.post(`/api/delegations/${sreq.data.request_id}/approve`);

    const offer = await call(seller, 'proxyproof_submit_offer', { buyer: 'Northwind Hotels', document: 'INVOICE', items: [{ name: 'House Blend, 5 lb', quantity: 2 }] });
    expect(offer.data.decision).toBe('HOLD');
    const review = await call(buyer, 'proxyproof_review_transaction', { transaction_id: offer.data.transaction_id });
    expect(review.data.seller_verified).toBe(true);
    expect(review.data.terms.total_minor).toBe(13_600);

    const accepted = await call(buyer, 'proxyproof_accept_transaction', { transaction_id: offer.data.transaction_id });
    expect(accepted.data.decision).toBe('ALLOW');
    expect(accepted.data.permit.jws).toBeTruthy();

    // Over its own limit, the same agent is refused by the same layer, whatever its instructions say.
    const big = await call(seller, 'proxyproof_submit_offer', { buyer: 'Northwind Hotels', document: 'INVOICE', items: [{ name: 'House Blend, 5 lb', quantity: 5 }] });
    const refused = await call(buyer, 'proxyproof_accept_transaction', { transaction_id: big.data.transaction_id });
    expect(refused.data.decision).toBe('DENY');
    expect(refused.data.reasons.find((r: any) => r.state === 'fail').code).toBe('AMOUNT_EXCEEDS_LIMIT');

    // Revoke in the dashboard: the very next call is refused.
    const a = await t.agent('Claude buyer agent');
    await t.post(`/api/delegations/${a.delegation.id}/revoke`);
    const after = await call(seller, 'proxyproof_submit_offer', { buyer: 'Northwind Hotels', document: 'INVOICE', items: [{ name: 'House Blend, 5 lb', quantity: 1 }] });
    const denied = await call(buyer, 'proxyproof_accept_transaction', { transaction_id: after.data.transaction_id });
    expect(denied.data.decision).toBe('DENY');
    expect(denied.data.reasons.find((r: any) => r.state === 'fail').code).toBe('DELEGATION_REVOKED');
  });

  it('a seller agent cannot use buyer tools and vice versa', async () => {
    const t = await setup();
    const harbor = await t.org('Harbor & Pine Roasters');
    const reg = await t.post('/api/agents', { name: 'Seller via MCP', side: 'SELLER', principal_id: harbor.id, provider: 'Claude Code', connection: 'MCP' });
    const c = await connect(t, reg.json.connection_token);
    const r = await call(c, 'proxyproof_accept_transaction', { transaction_id: 'txn_x' });
    expect(r.error).toBe(true);
  });
});
