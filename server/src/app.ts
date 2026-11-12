import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { all, one, run, type DB } from './db/index.js';
import { formatMinor, nowIso, sha256 } from './core/util.js';
import { verifyChain } from './core/ledger.js';
import { CATALOG, seedDemo } from './seed.js';
import { jwks, requestAudience, verifyReceipt } from './trust/credentials.js';
import { agentState, approveDelegation, Conflict, declineDelegation, delegationStatus, Forbidden, NotFound, parseJson as J, registerAgent, requestDelegation, revokeDelegation, StatusUnavailable } from './trust/registry.js';
import { approveReview, issueChallenge, listTransactions, proofBundle, recheck, submitAcceptance, submitOffer, transactionView, verifyBundle } from './trust/bilateral.js';
import { SELLER_EXTRA, SIDE_CHECKS } from './trust/party.js';
import { BEHAVIOURS, buyerAccept, sellerOffer } from './runtime/testAgent.js';
import { mountMcp } from './mcp/server.js';
import { approveRun, captureRun, getRun, listRuns, listScenarios, runScenario, type LabCtx } from './scenarios/engine.js';
import { GateRefused, captureCheckout, executeWithPermit, handleWebhook, syncPayment, type ExecutorCtx } from './executor/gate.js';
import { createPayPal, type PayPal } from './executor/paypal.js';

type Session = { userId: string; workspaceId: string; name: string };
type Vars = { Variables: { session: Session } };
const COOKIE = 'pp_session';
export type AppDeps = { db: DB; config: Config; paypal?: PayPal };

export function createApp(deps: AppDeps) {
  const { db, config } = deps;
  const paypal = deps.paypal ?? createPayPal(config);
  const isTest = config.NODE_ENV === 'test';
  const sellerAccount = config.PAYPAL_SANDBOX_MERCHANT_EMAIL ?? 'payments@harborpine.example';
  const buyerEmail = config.PAYPAL_SANDBOX_RECEIVER_EMAIL ?? 'ap@northwind.example';

  /** Sandbox money is shared by every judge, so live payment calls are capped per workspace and per day. */
  const quota = (ws: string): string | null => {
    const today = new Date().toISOString().slice(0, 10);
    const mine = one<any>(db, 'SELECT COUNT(*) c FROM payment_attempts WHERE workspace_id = ? AND created_at >= ?', ws, today).c;
    const total = one<any>(db, 'SELECT COUNT(*) c FROM payment_attempts WHERE created_at >= ?', today).c;
    if (mine >= config.SANDBOX_PAYMENTS_PER_WORKSPACE) return `This workspace has used its ${config.SANDBOX_PAYMENTS_PER_WORKSPACE} sandbox checkouts for today. Open a new demo to continue.`;
    if (total >= config.SANDBOX_PAYMENTS_PER_DAY) return 'The shared sandbox checkout allowance for today is used up. Verification still works.';
    return null;
  };
  const ctx: ExecutorCtx = { db, publicUrl: config.PUBLIC_URL, paypal, quota };
  const app = new Hono<Vars>();

  const hits = new Map<string, { n: number; until: number }>();
  const limit = (key: string, max: number, windowMs: number) => {
    if (isTest) return true;
    const now = Date.now(), h = hits.get(key);
    if (!h || h.until < now) { hits.set(key, { n: 1, until: now + windowMs }); return true; }
    h.n++; return h.n <= max;
  };
  const ip = (c: any) => (config.TRUST_PROXY === '1' ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined) ?? (c.env?.incoming?.socket?.remoteAddress as string | undefined) ?? 'local';

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  // Dashboard calls carry a custom header a cross-site page cannot add without a CORS preflight. The agent API, MCP and
  // webhooks are exempt: they are authenticated by signatures or connection tokens, never by cookies.
  const SIGNED_ROUTES = /^\/api\/(v1\/|paypal\/webhooks)/;
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method) && !SIGNED_ROUTES.test(c.req.path) && c.req.header('x-proxyproof') !== '1') return c.json({ error: 'Missing request header.' }, 403);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof Forbidden) return c.json({ error: err.message }, 403);
    if (err instanceof NotFound) return c.json({ error: err.message }, 404);
    if (err instanceof Conflict) return c.json({ error: err.message }, 409);
    if (err instanceof GateRefused) return c.json({ error: err.message, code: err.code }, 403);
    if (err instanceof z.ZodError) return c.json({ error: 'Some fields are invalid.', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 400);
    if (err instanceof Error && /JWK|Ed25519|did:key/.test(err.message)) return c.json({ error: err.message }, 400);
    console.error('Unhandled error:', err?.message);
    return c.json({ error: 'The server could not finish this request.' }, 500);
  });

  // ---------- Sessions ----------
  const startSession = (c: any, userId: string, workspaceId: string) => {
    const token = randomBytes(32).toString('base64url');
    run(db, 'INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at) VALUES (?,?,?,?)', sha256(token), userId, workspaceId, new Date(Date.now() + 7 * 86_400_000).toISOString());
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: config.PUBLIC_URL.startsWith('https://'), path: '/', maxAge: 7 * 86400 });
  };
  const loadSession = (c: any): Session | null => {
    const t = getCookie(c, COOKIE);
    if (!t) return null;
    const r = one<any>(db, `SELECT s.user_id, s.workspace_id, u.name FROM sessions s JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(t), nowIso());
    return r ? { userId: r.user_id, workspaceId: r.workspace_id, name: r.name } : null;
  };
  const auth = async (c: any, next: any) => {
    const s = loadSession(c);
    if (!s) return c.json({ error: 'Open the live demo to continue.' }, 401);
    c.set('session', s);
    await next();
  };
  app.post('/api/demo/start', async (c) => {
    if (!limit(`demo:${ip(c)}`, 30, 3_600_000)) return c.json({ error: 'Too many demos from this address. Try again in an hour.' }, 429);
    const s = await seedDemo(db, { publicUrl: config.PUBLIC_URL, buyerEmail, sellerAccount });
    startSession(c, s.user, s.ws);
    return c.json({ workspaceId: s.ws });
  });
  app.get('/api/me', (c) => { const s = loadSession(c); return c.json({ user: s ? { name: s.name, workspaceId: s.workspaceId } : null }); });
  app.post('/api/auth/logout', (c) => {
    const t = getCookie(c, COOKIE);
    if (t) run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(t));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ---------- Public agent API (signature-authenticated; see docs/architecture/connector-api.md) ----------
  const wsOr404 = (c: any) => { const ws = c.req.param('ws'); if (!one(db, 'SELECT 1 FROM workspaces WHERE id = ?', ws)) throw new NotFound('Unknown workspace.'); return ws as string; };
  app.get('/.well-known/jwks.json', async (c) => c.json(await jwks(db)));
  app.get('/api/v1/workspaces/:ws/directory', (c) => {
    const ws = wsOr404(c);
    return c.json({ audience: requestAudience(config.PUBLIC_URL, ws), organizations: all<any>(db, 'SELECT name, role, did, status, payment_account FROM principals WHERE workspace_id = ? ORDER BY role, name', ws) });
  });
  app.post('/api/v1/workspaces/:ws/agents', async (c) => {
    if (!limit(`reg:${ip(c)}`, 30, 3_600_000)) return c.json({ error: 'Too many registrations.' }, 429);
    const ws = wsOr404(c);
    const b = z.object({ name: z.string().min(1).max(80), side: z.enum(['BUYER', 'SELLER']), organization_did: z.string(), public_jwk: z.record(z.string(), z.unknown()), provider: z.string().max(40).optional() }).parse(await c.req.json());
    const org = one<any>(db, 'SELECT id FROM principals WHERE workspace_id = ? AND did = ?', ws, b.organization_did);
    if (!org) throw new NotFound('No organization with that DID in this workspace.');
    const r = await registerAgent(db, ws, { name: b.name, side: b.side, principalId: org.id, publicJwk: b.public_jwk, provider: b.provider ?? 'Custom', connection: 'API' }, { type: 'AGENT', id: 'self-registration' });
    return c.json({ agent_id: r.id, did: r.did, state: 'CONNECTED', authorized: false, next: 'The organization must approve a delegation in ProxyProof before this agent can act.' }, 201);
  });
  /** An agent collects the credential its organization signed for it. Not secret: useless without the agent's private key. */
  app.post('/api/v1/workspaces/:ws/agents/credential', async (c) => {
    const ws = wsOr404(c);
    const b = z.object({ agent: z.string() }).parse(await c.req.json());
    const a = one<any>(db, 'SELECT id FROM agents WHERE workspace_id = ? AND did = ?', ws, b.agent);
    const st = a ? agentState(db, a.id) : null;
    if (!st?.active) return c.json({ authorized: false, state: st?.state ?? 'UNKNOWN_AGENT', credential: null });
    return c.json({ authorized: st.state === 'AUTHORIZED', state: st.state, credential: st.active.credential, valid_until: st.active.valid_until, mandate: J(st.active.mandate, null) });
  });
  app.post('/api/v1/workspaces/:ws/challenges', async (c) => {
    if (!limit(`ch:${ip(c)}`, 600, 3_600_000)) return c.json({ error: 'Too many challenges.' }, 429);
    const ws = wsOr404(c);
    const b = z.object({ agent: z.string() }).parse(await c.req.json());
    return c.json({ ...issueChallenge(db, ws, b.agent), audience: requestAudience(config.PUBLIC_URL, ws) });
  });
  const publicView = (txId: string) => {
    const v = transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId));
    return {
      transaction_id: v.id, version: v.version, terms: v.terms, terms_hash: v.terms_hash, decision: v.decision,
      reasons: v.reasons, payment_state: v.payment_state, decision_receipt: v.decision_receipt,
      checks: [...v.seller.checks, ...v.buyer.checks, ...v.match].map((x: any) => ({ group: x.group, key: x.key, state: x.state, code: x.code ?? null })),
      payment: v.payment ? { status: v.payment.status, payer_link: v.payment.payer_link, provider_ref: v.payment.provider_ref } : null,
    };
  };
  const PartyBody = z.object({ request: z.string().max(20_000), delegation: z.string().max(20_000).nullish() });
  app.post('/api/v1/workspaces/:ws/offers', async (c) => {
    if (!limit(`tx:${ip(c)}`, 600, 3_600_000)) return c.json({ error: 'Too many requests.' }, 429);
    const ws = wsOr404(c);
    const b = PartyBody.extend({ terms: z.unknown(), transaction_id: z.string().max(60).optional() }).parse(await c.req.json());
    const id = await submitOffer(ctx, ws, { request: b.request, delegation: b.delegation ?? undefined, terms: b.terms, transactionId: b.transaction_id });
    return c.json(publicView(id));
  });
  app.get('/api/v1/workspaces/:ws/transactions/:id', (c) => {
    const ws = wsOr404(c);
    if (!one(db, 'SELECT 1 FROM commerce_transactions WHERE id = ? AND workspace_id = ?', c.req.param('id'), ws)) throw new NotFound('Unknown transaction.');
    return c.json(publicView(c.req.param('id')));
  });
  app.post('/api/v1/workspaces/:ws/transactions/:id/accept', async (c) => {
    if (!limit(`tx:${ip(c)}`, 600, 3_600_000)) return c.json({ error: 'Too many requests.' }, 429);
    const ws = wsOr404(c);
    const b = PartyBody.parse(await c.req.json());
    const r = await submitAcceptance(ctx, ws, c.req.param('id'), { request: b.request, delegation: b.delegation ?? undefined });
    return c.json({ ...publicView(c.req.param('id')), permit: r.permit });
  });
  /** The protected action. Nothing else in ProxyProof can create a PayPal checkout. */
  app.post('/api/v1/workspaces/:ws/transactions/:id/execute', async (c) => {
    const ws = wsOr404(c);
    const b = z.object({ permit: z.string().max(5_000).optional() }).parse(await c.req.json().catch(() => ({})));
    await executeWithPermit(ctx, ws, c.req.param('id'), b.permit, { type: 'AGENT', id: 'permit-holder' });
    return c.json(publicView(c.req.param('id')));
  });
  app.get('/api/v1/workspaces/:ws/transactions/:id/proof', async (c) => c.json(await proofBundle(ctx, wsOr404(c), c.req.param('id'))));
  app.post('/api/v1/proofs/verify', async (c) => c.json(await verifyBundle(db, z.object({ bundle: z.unknown(), signature: z.string().max(5_000) }).parse(await c.req.json()))));
  app.post('/api/v1/receipts/verify', async (c) => {
    const b = z.object({ receipt: z.string().max(20_000) }).parse(await c.req.json());
    try { return c.json({ valid: true, payload: await verifyReceipt(db, b.receipt) }); } catch { return c.json({ valid: false }); }
  });
  app.get('/api/v1/status/:id', (c) => {
    const d = one<any>(db, 'SELECT workspace_id FROM delegations WHERE id = ?', c.req.param('id'));
    if (!d) return c.json({ id: c.req.param('id'), status: 'UNKNOWN' }, 404);
    try { return c.json({ id: c.req.param('id'), status: delegationStatus(db, d.workspace_id, c.req.param('id')), checked_at: nowIso() }); }
    catch (e) { if (e instanceof StatusUnavailable) return c.json({ error: e.message }, 503); throw e; }
  });

  // ---------- MCP connector ----------
  const inProcess = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await app.request(path, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  mountMcp(app, ctx, inProcess);

  // ---------- Dashboard ----------
  const agentView = (a: any) => {
    const st = agentState(db, a.id);
    const d = st.active ?? st.latest;
    return {
      id: a.id, name: a.name, side: a.side, did: a.did, thumbprint: a.thumbprint, provider: a.provider, connection: a.connection, assurance: a.assurance, principal_id: a.principal_id, last_seen_at: a.last_seen_at,
      state: st.state,
      delegation: d ? { id: d.id, status: d.status, mandate: J(d.mandate, null), valid_from: d.valid_from, valid_until: d.valid_until, approved_at: d.approved_at, revoked_at: d.revoked_at, revoked_reason: d.revoked_reason, parent_id: d.parent_id } : null,
      pending: st.pending ? { id: st.pending.id, mandate: J(st.pending.mandate, null), valid_until: st.pending.valid_until, requested_at: st.pending.requested_at } : null,
    };
  };
  app.get('/api/state', auth, (c) => {
    const s = c.get('session');
    const w = one<any>(db, 'SELECT * FROM workspaces WHERE id = ?', s.workspaceId);
    return c.json({
      workspace: { id: w.id, name: w.name, status_service: w.status_service, audience: requestAudience(config.PUBLIC_URL, w.id), mcp_url: `${config.PUBLIC_URL}/mcp` },
      user: { name: s.name },
      organizations: all<any>(db, 'SELECT id, name, role, did, status, verification_method, payment_account, key_status FROM principals WHERE workspace_id = ? ORDER BY role, created_at', s.workspaceId),
      agents: all<any>(db, 'SELECT * FROM agents WHERE workspace_id = ? ORDER BY created_at', s.workspaceId).map(agentView),
      catalog: CATALOG.map((p) => ({ ...p, price: formatMinor(p.unit_amount_minor) })),
      checks: { side: SIDE_CHECKS.map(([key, label]) => ({ key, label })), seller_extra: SELLER_EXTRA.map(([key, label]) => ({ key, label })) },
      behaviours: BEHAVIOURS,
      paypal: { configured: paypal.configured, webhook: paypal.webhookConfigured, buyer: buyerEmail, seller_account: sellerAccount },
      chain: verifyChain(db, s.workspaceId),
    });
  });
  app.get('/api/transactions', auth, (c) => c.json({ transactions: listTransactions(db, c.get('session').workspaceId) }));
  app.get('/api/transactions/:id', auth, (c) => {
    const row = one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', c.req.param('id'), c.get('session').workspaceId);
    if (!row) throw new NotFound('Unknown transaction.');
    return c.json(transactionView(db, row));
  });
  app.post('/api/agents', auth, async (c) => {
    const s = c.get('session');
    const b = z.object({ name: z.string().min(1).max(80), side: z.enum(['BUYER', 'SELLER']), principal_id: z.string(), provider: z.string().max(40).default('Custom'), connection: z.enum(['TEST_RUNTIME', 'API', 'MCP']).default('TEST_RUNTIME'), public_jwk: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json());
    const r = await registerAgent(db, s.workspaceId, { name: b.name, side: b.side, principalId: b.principal_id, publicJwk: b.public_jwk, provider: b.provider, connection: b.connection }, { type: 'USER', id: s.userId });
    return c.json({ id: r.id, did: r.did, connection_token: r.token, mcp_url: `${config.PUBLIC_URL}/mcp` }, 201);
  });
  app.post('/api/agents/:id/delegations', auth, async (c) => {
    const s = c.get('session');
    const b = z.object({ mandate: z.unknown(), valid_until: z.string() }).parse(await c.req.json());
    return c.json({ id: requestDelegation(db, s.workspaceId, c.req.param('id'), { mandate: b.mandate, validUntil: b.valid_until }, { type: 'USER', id: s.userId }) }, 201);
  });
  app.post('/api/delegations/:id/approve', auth, async (c) => { const s = c.get('session'); await approveDelegation(db, s.workspaceId, c.req.param('id'), { id: s.userId, name: s.name }, config.PUBLIC_URL); return c.json({ ok: true }); });
  app.post('/api/delegations/:id/decline', auth, (c) => { const s = c.get('session'); declineDelegation(db, s.workspaceId, c.req.param('id'), s.userId); return c.json({ ok: true }); });
  app.post('/api/delegations/:id/revoke', auth, (c) => { const s = c.get('session'); revokeDelegation(db, s.workspaceId, c.req.param('id'), s.userId); return c.json({ ok: true }); });
  app.post('/api/settings/status-service', auth, async (c) => {
    const s = c.get('session');
    const b = z.object({ up: z.boolean() }).parse(await c.req.json());
    run(db, 'UPDATE workspaces SET status_service = ? WHERE id = ?', b.up ? 'UP' : 'DOWN', s.workspaceId);
    return c.json({ ok: true });
  });

  /** Drives labelled test agents. They reach ProxyProof through the public API above (inProcess), exactly like external agents. */
  const actLimit = (s: Session) => { if (!limit(`act:${s.workspaceId}`, 300, 3_600_000)) throw new Forbidden('Too many agent actions. Try again later.'); };
  const Draft = z.object({ reference: z.string().min(1).max(60), document: z.enum(['QUOTE', 'INVOICE']), currency: z.string().length(3).default('USD'), items: z.array(z.object({ name: z.string(), category: z.string(), quantity: z.number().int().positive(), unit_amount_minor: z.number().int().nonnegative() })).min(1), payment_destination: z.string().max(200), expires_in_s: z.number().int().optional() });
  app.post('/api/runtime/offer', auth, async (c) => {
    const s = c.get('session'); actLimit(s);
    const b = z.object({ agent_id: z.string(), buyer_org_id: z.string(), behaviour: z.enum(BEHAVIOURS).default('honest'), draft: Draft, transaction_id: z.string().optional() }).parse(await c.req.json());
    return c.json(await sellerOffer(db, inProcess, { workspaceId: s.workspaceId, publicUrl: config.PUBLIC_URL, agentId: b.agent_id, buyerOrgId: b.buyer_org_id, draft: b.draft, behaviour: b.behaviour, transactionId: b.transaction_id }));
  });
  app.post('/api/runtime/accept', auth, async (c) => {
    const s = c.get('session'); actLimit(s);
    const b = z.object({ agent_id: z.string(), transaction_id: z.string(), behaviour: z.enum(BEHAVIOURS).default('honest') }).parse(await c.req.json());
    return c.json(await buyerAccept(db, inProcess, { workspaceId: s.workspaceId, publicUrl: config.PUBLIC_URL, agentId: b.agent_id, transactionId: b.transaction_id, behaviour: b.behaviour }));
  });
  /** The buyer agent spends its permit on the protected action, through the same public execute route. */
  app.post('/api/runtime/execute', auth, async (c) => {
    const s = c.get('session'); actLimit(s);
    const b = z.object({ transaction_id: z.string(), permit: z.string().optional() }).parse(await c.req.json());
    const r = await inProcess('POST', `/api/v1/workspaces/${s.workspaceId}/transactions/${b.transaction_id}/execute`, { permit: b.permit });
    return c.json(r.json, r.status as any);
  });
  // ---------- Scenario lab: real-world scenarios, each played in its own isolated world through the public agent API ----------
  const lab: LabCtx = { db, publicUrl: config.PUBLIC_URL, api: inProcess, executor: ctx, sellerAccount, buyerEmail };
  app.get('/api/lab/scenarios', auth, (c) => c.json(listScenarios()));
  app.get('/api/lab/runs', auth, (c) => c.json({ runs: listRuns(db, c.get('session').workspaceId) }));
  app.post('/api/lab/runs', auth, async (c) => {
    const s = c.get('session');
    if (!limit(`lab:${s.workspaceId}`, 120, 3_600_000)) throw new Forbidden('Too many scenario runs. Try again later.');
    const b = z.object({ prompt: z.string().max(40), complication: z.string().max(40) }).parse(await c.req.json());
    return c.json(await runScenario(lab, s.workspaceId, b.prompt, b.complication, { pause: true }), 201);
  });
  app.get('/api/lab/runs/:id', auth, async (c) => c.json(await getRun(lab, c.get('session').workspaceId, c.req.param('id'), { sync: c.req.query('sync') === '1' })));
  app.post('/api/lab/runs/:id/approve', auth, async (c) => c.json(await approveRun(lab, c.get('session').workspaceId, c.req.param('id'))));
  app.post('/api/lab/runs/:id/capture', auth, async (c) => c.json(await captureRun(lab, c.get('session').workspaceId, c.req.param('id'))));
  const view = (ws: string, id: string) => transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ? AND workspace_id = ?', id, ws));
  app.post('/api/transactions/:id/review', auth, async (c) => { const s = c.get('session'); const r = await approveReview(ctx, s.workspaceId, c.req.param('id'), { id: s.userId, name: s.name }); return c.json({ ...view(s.workspaceId, c.req.param('id')), permit: r.permit }); });
  app.post('/api/transactions/:id/recheck', auth, async (c) => { const s = c.get('session'); const r = await recheck(ctx, s.workspaceId, c.req.param('id'), { type: 'USER', id: s.userId }); return c.json({ ...view(s.workspaceId, c.req.param('id')), permit: r.permit }); });
  app.post('/api/transactions/:id/capture', auth, async (c) => { const s = c.get('session'); await captureCheckout(ctx, s.workspaceId, c.req.param('id'), { type: 'USER', id: s.userId }); return c.json(view(s.workspaceId, c.req.param('id'))); });
  app.post('/api/transactions/:id/sync', auth, async (c) => { const s = c.get('session'); await syncPayment(ctx, s.workspaceId, c.req.param('id')); return c.json(view(s.workspaceId, c.req.param('id'))); });
  app.get('/api/audit', auth, (c) => {
    const s = c.get('session');
    return c.json({ chain: verifyChain(db, s.workspaceId), events: all<any>(db, 'SELECT seq, event_type, actor_type, actor_id, subject_id, payload, hash, created_at FROM audit_events WHERE workspace_id = ? ORDER BY seq DESC LIMIT 200', s.workspaceId).map((e) => ({ ...e, payload: J(e.payload, {}) })) });
  });
  app.get('/api/test-report', (c) => {
    try { return c.json(JSON.parse(readFileSync('./docs/testing/test-report.json', 'utf8'))); } catch { return c.json({ available: false }); }
  });

  app.post('/api/paypal/webhooks', async (c) => {
    const raw = await c.req.text();
    if (raw.length > 256_000) return c.json({ error: 'Too large.' }, 413);
    const headers: Record<string, string | undefined> = {};
    for (const h of ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']) headers[h] = c.req.header(h);
    const r = await handleWebhook(ctx, headers, raw);
    return c.json(r, r.accepted ? 200 : 400);
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  return { app, ctx };
}
