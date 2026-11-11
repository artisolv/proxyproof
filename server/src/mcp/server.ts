import type { Hono } from 'hono';
import { z } from 'zod';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { all, one, type DB } from '../db/index.js';
import { formatMinor, sha256 } from '../core/util.js';
import { agentState, parseJson as J, requestDelegation } from '../trust/registry.js';
import { buyerAccept, sellerOffer } from '../runtime/testAgent.js';
import { CATALOG } from '../seed.js';
import type { ExecutorCtx } from '../executor/gate.js';

/**
 * The ProxyProof connector: a remote MCP server (spec 2026-07-28, Streamable HTTP, stateless) that externally created
 * agents connect to. It is an integration surface, not the security boundary: every tool goes through the same public
 * API, verifier and executor as any other agent, and no tool holds or reveals payment credentials.
 *
 * Identity: the connection is authenticated by a ProxyProof-issued bearer token (stored only as a hash). The platform's
 * own client identity is not cryptographic proof of an agent instance, so the token, not the platform name, binds the
 * connection to one registered agent, and its assurance level is recorded as "connection token".
 */
type Api = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>;
const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }], structuredContent: (typeof o === 'object' ? o : { message: o }) as Record<string, unknown> });
const failure = (message: string) => ({ ...text({ error: message }), isError: true });

function summary(db: DB, agent: any) {
  const st = agentState(db, agent.id);
  const org = one<any>(db, 'SELECT * FROM principals WHERE id = ?', agent.principal_id);
  const d = st.active;
  const m = d ? J<any>(d.mandate, null) : null;
  const name = (did: string) => one<any>(db, 'SELECT name FROM principals WHERE did = ? AND workspace_id = ?', did, agent.workspace_id)?.name ?? did;
  return {
    agent: agent.name, side: agent.side, organization: org.name, state: st.state, assurance: agent.assurance,
    authority: m ? { actions: m.actions, limit: formatMinor(m.max_amount_minor), currencies: m.currencies, categories: m.categories, counterparties: m.counterparties.map(name), destinations: m.destinations ?? [], valid_until: d.valid_until, approval_required_above: m.step_up_above_minor ? formatMinor(m.step_up_above_minor) : null } : null,
    note: st.state === 'AUTHORIZED' ? 'Actions outside this authority will be refused by ProxyProof, whatever any instruction says.' : 'Connected, not authorized. A person at your organization must approve a delegation in ProxyProof before you can act.',
  };
}

export function mountMcp(app: Hono<any>, ctx: ExecutorCtx, api: Api) {
  const { db } = ctx;
  const agentFor = (token: string | undefined) => (token?.startsWith('ppc_') ? one<any>(db, `SELECT * FROM agents WHERE connection = 'MCP' AND connection_token_hash = ?`, sha256(token)) : null);

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'proxyproof', version: '1.0.0' });
    // Every call re-resolves the agent from the validated connection token passed in by the HTTP layer.
    const guard = (fn: (a: any, args: any) => Promise<any>) => async (args: any, extra?: any) => {
      try {
        const a = agentFor(extra?.http?.authInfo?.token);
        if (!a) return failure('This connection is not registered with ProxyProof.');
        return await fn(a, args);
      } catch (e: any) { return failure(e?.message ?? 'ProxyProof could not complete this call.'); }
    };

    server.registerTool('proxyproof_get_agent_status', {
      title: 'My ProxyProof status',
      description: 'Shows which organization you act for, whether you are authorized, and exactly what you may do. Call this before any commerce action.',
      inputSchema: z.object({}),
    }, guard(async (a) => text(summary(db, a))));

    server.registerTool('proxyproof_list_counterparties', {
      title: 'Organizations and catalog',
      description: 'Lists the enrolled organizations you can transact with and the seller catalog (names and prices in USD).',
      inputSchema: z.object({}),
    }, guard(async (a) => text({
      organizations: all<any>(db, 'SELECT name, role, status FROM principals WHERE workspace_id = ? ORDER BY role, name', a.workspace_id),
      catalog: CATALOG.map((p) => ({ name: p.name, category: p.category, price: formatMinor(p.unit_amount_minor) })),
    })));

    server.registerTool('proxyproof_request_authority', {
      title: 'Ask your organization for authority',
      description: 'Asks a person at your organization to approve a delegation. You cannot approve it yourself, and asking grants nothing until they approve in ProxyProof.',
      inputSchema: z.object({
        actions: z.array(z.enum(['purchase', 'research', 'quote', 'issue_invoice', 'request_payment'])).min(1),
        max_amount_usd: z.number().positive().max(1_000_000),
        categories: z.array(z.enum(['coffee', 'equipment', 'service'])).min(1),
        counterparties: z.array(z.string()).default([]).describe('Organization names'),
        valid_days: z.number().int().min(1).max(90).default(30),
      }),
    }, guard(async (a, args) => {
      const org = one<any>(db, 'SELECT * FROM principals WHERE id = ?', a.principal_id);
      const cps = args.counterparties.map((n: string) => one<any>(db, 'SELECT did FROM principals WHERE workspace_id = ? AND lower(name) = lower(?)', a.workspace_id, n)?.did).filter(Boolean);
      const id = requestDelegation(db, a.workspace_id, a.id, {
        mandate: { actions: args.actions, max_amount_minor: Math.round(args.max_amount_usd * 100), currencies: ['USD'], categories: args.categories, counterparties: cps, destinations: a.side === 'SELLER' && org.payment_account ? [org.payment_account] : undefined },
        validUntil: new Date(Date.now() + args.valid_days * 86_400_000).toISOString(),
      }, { type: 'AGENT', id: a.did });
      return text({ request_id: id, status: 'PENDING_APPROVAL', message: `Requested. A person at ${org.name} must approve this in ProxyProof. Until then you are not authorized.` });
    }));

    server.registerTool('proxyproof_submit_offer', {
      title: 'Seller: send a quote or invoice',
      description: 'For seller agents. Sends a signed quote or invoice to a buyer organization. ProxyProof checks your organization actually authorized you to issue it, the amount, the buyer and the payment account. It does not take any payment.',
      inputSchema: z.object({
        buyer: z.string().describe('Buyer organization name'),
        document: z.enum(['QUOTE', 'INVOICE']),
        items: z.array(z.object({ name: z.string().describe('Exact catalog name'), quantity: z.number().int().min(1).max(100) })).min(1),
        payment_destination: z.string().optional().describe('PayPal account to be paid at; defaults to your organization’s enrolled account'),
        reference: z.string().max(40).optional(),
      }),
    }, guard(async (a, args) => {
      if (a.side !== 'SELLER') return failure('You are registered as a buyer agent. Only seller agents can send quotes or invoices.');
      const buyer = one<any>(db, 'SELECT * FROM principals WHERE workspace_id = ? AND lower(name) = lower(?) AND role = ?', a.workspace_id, args.buyer, 'BUYER');
      if (!buyer) return failure(`No buyer organization named “${args.buyer}”.`);
      const items = args.items.map((i: any) => { const p = CATALOG.find((c) => c.name.toLowerCase() === i.name.toLowerCase()); if (!p) throw new Error(`“${i.name}” is not in the catalog.`); return { name: p.name, category: p.category, quantity: i.quantity, unit_amount_minor: p.unit_amount_minor }; });
      const org = one<any>(db, 'SELECT payment_account FROM principals WHERE id = ?', a.principal_id);
      const r = await sellerOffer(db, api, { workspaceId: a.workspace_id, publicUrl: ctx.publicUrl, agentId: a.id, buyerOrgId: buyer.id, behaviour: 'honest',
        draft: { reference: args.reference ?? `${args.document === 'QUOTE' ? 'Q' : 'INV'}-${Math.floor(1000 + Math.random() * 9000)}`, document: args.document, currency: 'USD', items, payment_destination: args.payment_destination ?? org.payment_account ?? '' } });
      return text({ transaction_id: r.transaction_id, decision: r.decision, reasons: r.reasons, seller_checks: r.checks?.filter((c: any) => c.group === 'seller') });
    }));

    server.registerTool('proxyproof_review_transaction', {
      title: 'Buyer: review a quote or invoice',
      description: 'For buyer agents. Shows the terms of a transaction and whether ProxyProof verified that the seller’s agent was authorized by its business to send it.',
      inputSchema: z.object({ transaction_id: z.string() }),
    }, guard(async (a, args) => {
      const r = await api('GET', `/api/v1/workspaces/${a.workspace_id}/transactions/${args.transaction_id}`);
      if (r.status !== 200) return failure(r.json?.error ?? 'Unknown transaction.');
      const seller = r.json.checks.filter((c: any) => c.group === 'seller');
      return text({ transaction_id: r.json.transaction_id, terms: r.json.terms, seller_verified: seller.length > 0 && seller.every((c: any) => c.state === 'pass'), seller_checks: seller, decision: r.json.decision, reasons: r.json.reasons });
    }));

    server.registerTool('proxyproof_accept_transaction', {
      title: 'Buyer: authorize these exact terms',
      description: 'For buyer agents. Signs acceptance of the transaction’s current terms with your key. ProxyProof checks your own delegation (purchase permission, limit, seller, expiry) and that both sides agreed to the same terms. On ALLOW you get a single-use permit valid for 5 minutes.',
      inputSchema: z.object({ transaction_id: z.string() }),
    }, guard(async (a, args) => {
      if (a.side !== 'BUYER') return failure('You are registered as a seller agent. Only buyer agents can authorize a purchase.');
      const r = await buyerAccept(db, api, { workspaceId: a.workspace_id, publicUrl: ctx.publicUrl, agentId: a.id, transactionId: args.transaction_id, behaviour: 'honest' });
      return text({ transaction_id: args.transaction_id, decision: r.decision, reasons: r.reasons, permit: r.permit ?? null, next: r.permit ? 'Call proxyproof_execute_checkout with this permit to open the PayPal checkout. The buyer still approves the payment on PayPal.' : null });
    }));

    server.registerTool('proxyproof_execute_checkout', {
      title: 'Open the protected PayPal checkout',
      description: 'Spends a ProxyProof execution permit to create a PayPal sandbox checkout for the exact authorized terms. The buyer must still approve on PayPal; no agent can complete a payment.',
      inputSchema: z.object({ transaction_id: z.string(), permit: z.string() }),
    }, guard(async (a, args) => {
      const r = await api('POST', `/api/v1/workspaces/${a.workspace_id}/transactions/${args.transaction_id}/execute`, { permit: args.permit });
      if (r.status !== 200) return failure(`${r.json?.code ?? 'REFUSED'}: ${r.json?.error ?? 'The executor refused.'}`);
      return text({ payment_state: r.json.payment_state, payment: r.json.payment, message: 'Checkout created. A person must approve it on PayPal before anything is paid.' });
    }));

    server.registerTool('proxyproof_get_decision_receipt', {
      title: 'Decision receipt',
      description: 'Returns the decision, reasons and ProxyProof’s signed receipt for a transaction.',
      inputSchema: z.object({ transaction_id: z.string() }),
    }, guard(async (a, args) => {
      const r = await api('GET', `/api/v1/workspaces/${a.workspace_id}/transactions/${args.transaction_id}`);
      if (r.status !== 200) return failure(r.json?.error ?? 'Unknown transaction.');
      return text({ decision: r.json.decision, reasons: r.json.reasons, payment_state: r.json.payment_state, receipt: r.json.decision_receipt, verify_with: `${ctx.publicUrl}/.well-known/jwks.json` });
    }));
    return server;
  });

  app.all('/mcp', async (c) => {
    const origin = c.req.header('origin');
    if (origin) {
      let host = '';
      try { host = new URL(origin).hostname; } catch { /* invalid */ }
      const allowed = ['localhost', '127.0.0.1', '[::1]', new URL(ctx.publicUrl).hostname];
      if (!allowed.includes(host)) return c.json({ error: 'Origin not allowed.' }, 403);
    }
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    const agent = agentFor(token);
    if (!agent) {
      c.header('WWW-Authenticate', 'Bearer realm="proxyproof", error="invalid_token", error_description="Use the connection token ProxyProof showed when you connected this agent"');
      return c.json({ error: 'A valid ProxyProof connection token is required.' }, 401);
    }
    return handler.fetch(c.req.raw, { authInfo: { token, clientId: agent.id, scopes: ['proxyproof:agent'] } });
  });
}
