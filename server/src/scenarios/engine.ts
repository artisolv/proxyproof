import { all, one, run, type DB } from '../db/index.js';
import { formatMinor, newId, nowIso } from '../core/util.js';
import { createWorkspace, DEMO_ENROLLMENT } from '../seed.js';
import { agentState, approveDelegation, Conflict, createPrincipal, NotFound, parseJson as J, registerAgent, requestDelegation, revokeDelegation } from '../trust/registry.js';
import { approveReview, recheck, transactionView } from '../trust/bilateral.js';
import { captureCheckout, syncPayment, type ExecutorCtx } from '../executor/gate.js';
import type { Behaviour } from '../runtime/testAgent.js';
import { TestRuntimeDriver, type AgentDriver, type Api, type DriverEnv } from './drivers.js';
import { COMPLICATIONS, compose, PRODUCTS, PROMPTS, WORLD, type Rules, type Scenario, type Step } from './catalog.js';

/**
 * The scenario engine. Each run builds a fresh, isolated world (two businesses, their agents and delegations, made with
 * the same registry functions the product uses), then plays the scenario's steps through the public agent API.
 *
 * A scenario only sets up conditions (an agent revoked, a payout account changed in the invoice, terms altered in
 * transit...) and tells the agents what to attempt. Whether each step passes, and why it fails, is whatever ProxyProof's
 * verification returns: no outcome is keyed to a scenario. The run records a snapshot after every step so the dashboard
 * can replay the transaction card by card.
 */
export type LabCtx = { db: DB; publicUrl: string; api: Api; executor: ExecutorCtx; sellerAccount: string; buyerEmail: string; drivers?: Partial<Record<string, AgentDriver>> };

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** Builds the scenario world in its own workspace. Returns name → id maps for organizations and agents. */
async function buildWorld(ctx: LabCtx, rules: Rules = {}) {
  const { db } = ctx;
  const { ws, user } = createWorkspace(db, 'ProxyProof scenario run', 'Scenario operator');
  const me = { id: user, name: 'Scenario operator' };
  const orgs: Record<string, string> = {}, agents: Record<string, string> = {};
  const did = (name: string) => one<any>(db, 'SELECT did FROM principals WHERE id = ?', orgs[name]).did;
  for (const o of WORLD.organizations) {
    const account = o.payout === 'SANDBOX_SELLER' ? ctx.sellerAccount : o.payout === 'SANDBOX_BUYER' ? ctx.buyerEmail : o.payout ?? null;
    orgs[o.name] = createPrincipal(db, ws, { name: o.name, role: o.role, verified: o.enrolled, method: o.enrolled ? DEMO_ENROLLMENT : undefined, paymentAccount: account });
  }
  for (const a of WORLD.agents) {
    const { id } = await registerAgent(db, ws, { name: a.name, side: a.side, principalId: orgs[a.org], provider: 'ProxyProof test agent' }, { type: 'SYSTEM' });
    agents[a.name] = id;
    if (!a.mandate) continue;
    // The user's rules replace the defaults for the two main agents.
    const r = a.name === 'Northwind Procurement Agent' ? rules.buyer : undefined;
    const sr = a.name === 'Harbor & Pine Sales Agent' ? rules.seller : undefined;
    const m = {
      ...a.mandate,
      ...(r?.max != null ? { max_minor: Math.round(r.max * 100) } : {}),
      ...(r?.reviewAbove != null ? { review_above_minor: Math.round(r.reviewAbove * 100) } : {}),
      ...(r?.categories ? { categories: r.categories } : {}),
      ...(r?.suppliers ? { counterparties: r.suppliers } : {}),
      ...(sr?.mayInvoice === false ? { actions: ['quote'] } : {}),
    };
    const mandate = {
      actions: m.actions, max_amount_minor: m.max_minor, currencies: ['USD'], categories: m.categories,
      counterparties: (m.counterparties ?? []).map(did),
      ...(a.side === 'SELLER' ? { destinations: (m.destinations ?? []).map((d) => (d === 'SANDBOX_SELLER' ? ctx.sellerAccount : d)) } : {}),
      ...(m.review_above_minor ? { step_up_above_minor: m.review_above_minor } : {}),
    };
    const window = a.status === 'expired' ? { validFrom: days(-40), validUntil: days(-10) } : { validUntil: days(30) };
    const d = requestDelegation(db, ws, id, { mandate, ...window }, { type: 'SYSTEM' });
    await approveDelegation(db, ws, d, me, ctx.publicUrl);
  }
  return { ws, user, orgs, agents };
}

const lineItems = (lines: [string, number][]) => lines.map(([name, quantity]) => {
  const p = PRODUCTS.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown product: ${name}`);
  return { name: p.name, category: p.category, quantity, unit_amount_minor: p.unit_amount_minor };
});

/** An agent as the dashboard shows it: who it acts for, what it may do, and its live state. */
function agentCard(db: DB, agentId: string | undefined) {
  if (!agentId) return null;
  const a = one<any>(db, 'SELECT * FROM agents WHERE id = ?', agentId);
  const org = one<any>(db, 'SELECT * FROM principals WHERE id = ?', a.principal_id);
  const st = agentState(db, a.id);
  const d = st.active ?? st.latest;
  const m = d ? J<any>(d.mandate, null) : null;
  return {
    id: a.id, name: a.name, side: a.side, did: a.did, provider: a.provider, connection: a.connection, state: st.state,
    organization: { name: org.name, status: org.status, payout_account: org.payment_account },
    mandate: m ? { actions: m.actions, max: formatMinor(m.max_amount_minor), categories: m.categories, review_above: m.step_up_above_minor ? formatMinor(m.step_up_above_minor) : null, destinations: m.destinations ?? null, counterparties: (m.counterparties ?? []).map((x: string) => one<any>(db, 'SELECT name FROM principals WHERE did = ? AND workspace_id = ?', x, a.workspace_id)?.name ?? x) } : null,
    valid_until: d?.valid_until ?? null, revoked_reason: d?.revoked_reason ?? null,
  };
}

type StepRec = {
  n: number; do: Step['do']; actor: 'BUYER_AGENT' | 'SELLER_AGENT' | 'BUYER_ORG' | 'SELLER_ORG' | 'PROXYPROOF' | 'EXECUTOR' | 'WORLD';
  say: string; ok: boolean; result: string; code: string | null; http_status: number | null;
  tx: ReturnType<typeof transactionView> | null; buyer_agent: ReturnType<typeof agentCard>; seller_agent: ReturnType<typeof agentCard>; status_service: string;
};

type StepRecord = StepRec;
/** Everything needed to continue a run that is waiting for a person's approval. Kept server-side, never returned. */
type RunState = { prompt: string; complication: string; rules?: Rules; world: { ws: string; user: string; orgs: Record<string, string>; agents: Record<string, string> }; txId: string | null; permit?: string; spent?: string; next: number };

/** Runs one request × complication in a fresh world and stores the run. It stops early if a person must approve. */
export async function runScenario(ctx: LabCtx, ownerWorkspace: string, promptId: string, complicationId: string, opts: { pause?: boolean; rules?: Rules } = {}) {
  if (!compose(promptId, complicationId, opts.rules)) throw new NotFound('That combination of request and complication does not exist.');
  const world = await buildWorld(ctx, opts.rules);
  return play(ctx, ownerWorkspace, null, { prompt: promptId, complication: complicationId, rules: opts.rules, world, txId: null, next: 0 }, [], { pause: opts.pause ?? false, approve: false });
}

/** The presenter approves as the buyer organization's manager: the engine performs the signed approval and continues. */
export async function approveRun(ctx: LabCtx, ownerWorkspace: string, runId: string) {
  const row = one<any>(ctx.db, 'SELECT * FROM lab_runs WHERE id = ? AND owner_workspace_id = ?', runId, ownerWorkspace);
  if (!row) throw new NotFound('Unknown run.');
  const saved = J<any>(row.result, {});
  if (!saved.awaiting || !saved._state) throw new Conflict('This run is not waiting for an approval.');
  return play(ctx, ownerWorkspace, row.id, saved._state, saved.steps, { pause: true, approve: true });
}

async function play(ctx: LabCtx, ownerWorkspace: string, runId: string | null, st: RunState, steps: StepRecord[], opts: { pause: boolean; approve: boolean }) {
  const sc = compose(st.prompt, st.complication, st.rules)!;
  const { db } = ctx;
  const world = st.world;
  const env: DriverEnv = { db, api: ctx.api, workspaceId: world.ws, publicUrl: ctx.publicUrl };
  const driverFor = (agentName: string) => ctx.drivers?.[agentName] ?? TestRuntimeDriver;
  const agentId = (name: string) => { const id = world.agents[name]; if (!id) throw new Error(`Unknown agent in scenario: ${name}`); return id; };
  let txId = st.txId, permit = st.permit, spent = st.spent;
  let approveNow = opts.approve;
  let awaiting: { approver: string; say: string } | null = null;
  const snapshot = () => ({
    tx: txId ? transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId)) : null,
    buyer_agent: agentCard(db, world.agents[sc.cast.buyer]), seller_agent: agentCard(db, world.agents[sc.cast.seller]),
    status_service: one<any>(db, 'SELECT status_service FROM workspaces WHERE id = ?', world.ws).status_service,
  });
  // What ProxyProof said, in its own words: its most serious reason (fail, then hold, then review), preferring the side
  // that just acted. BUYER_AUTHORIZATION_PENDING is only "waiting for the buyer", so it never explains a stop.
  const reasonText = (v: any, side?: string) => {
    const rank = (x: any) => ({ fail: 0, hold: 1, review: 2 } as any)[x.state] * 2 + (side && x.side !== side ? 1 : 0);
    const r = [...(v?.reasons ?? [])].filter((x: any) => x.code !== 'BUYER_AUTHORIZATION_PENDING').sort((a: any, b: any) => rank(a) - rank(b))[0];
    return r ? { text: r.message as string, code: r.code as string } : null;
  };

  let i = st.next;
  for (; i < sc.steps.length; i++) {
    const step = sc.steps[i];
    // A person is asked to approve only when ProxyProof's decision is REVIEW; otherwise the step does not happen.
    // In the lab the run genuinely waits here: the presenter's click is what performs the signed approval.
    if (step.do === 'approve_if_asked') {
      const d = txId ? one<any>(db, 'SELECT decision FROM commerce_transactions WHERE id = ?', txId)?.decision : null;
      if (d !== 'REVIEW') continue;
      if (opts.pause && !approveNow) { awaiting = { approver: step.approver, say: step.say }; break; }
      approveNow = false;
    }
    let actor: StepRecord['actor'] = 'WORLD', ok = true, result = '', code: string | null = null, http: number | null = null;
    try {
      switch (step.do) {
        case 'revoke': {
          const id = agentId(step.agent);
          const d = one<any>(db, `SELECT id FROM delegations WHERE agent_id = ? AND status = 'ACTIVE' ORDER BY approved_at DESC LIMIT 1`, id);
          revokeDelegation(db, world.ws, d.id, world.user, step.reason);
          actor = one<any>(db, 'SELECT side FROM agents WHERE id = ?', id).side === 'SELLER' ? 'SELLER_ORG' : 'BUYER_ORG';
          result = `${step.agent}’s delegation is revoked: ${step.reason}.`;
          break;
        }
        case 'status': {
          run(db, 'UPDATE workspaces SET status_service = ? WHERE id = ?', step.up ? 'UP' : 'DOWN', world.ws);
          result = step.up ? 'The revocation status service is back.' : 'The revocation status service is unreachable.';
          break;
        }
        case 'offer':
        case 'revise': {
          actor = 'SELLER_AGENT';
          const payTo = !step.payTo || step.payTo === 'enrolled' ? ctx.sellerAccount : step.payTo;
          const buyerOrg = world.orgs[step.to ?? sc.cast.buyerOrg];
          const draft = { reference: sc.reference, document: step.document ?? 'INVOICE', currency: 'USD', items: lineItems(step.lines), payment_destination: payTo };
          const r = await driverFor(step.agent).offer(env, { agentId: agentId(step.agent), buyerOrgId: buyerOrg, draft, behaviour: (step.behaviour ?? 'honest') as Behaviour, transactionId: step.do === 'revise' ? txId ?? undefined : undefined });
          http = r.http_status ?? null;
          if (r.transaction_id) txId = r.transaction_id as string;
          const v = txId ? transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId)) : null;
          const sellerFail = v?.seller.checks.find((c: any) => ['fail', 'hold'].includes(c.state));
          const termsFail = v?.match.find((c: any) => c.state === 'fail');
          const bad = sellerFail ?? termsFail;
          if (!v) { ok = false; result = (r.error as string) ?? 'ProxyProof refused the request.'; code = (r.code as string) ?? null; }
          else if (bad) { ok = false; result = bad.detail; code = bad.code ?? null; }
          else result = step.do === 'revise' ? `New terms v${v.version}: ${v.amount}. The buyer’s earlier approval no longer applies.` : `Seller’s agent verified. ${v.document === 'QUOTE' ? 'Quote' : 'Invoice'} for ${v.amount} is waiting for the buyer’s agent.`;
          break;
        }
        case 'accept': {
          actor = 'BUYER_AGENT';
          if (!txId) throw new Error('There is no transaction to accept.');
          const r = await driverFor(step.agent).accept(env, { agentId: agentId(step.agent), transactionId: txId, behaviour: (step.behaviour ?? 'honest') as Behaviour });
          http = r.http_status ?? null;
          permit = (r.permit as any)?.jws ?? permit;
          const v = transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId));
          code = v.decision === 'ALLOW' ? null : reasonText(v, 'buyer')?.code ?? null;
          ok = v.decision === 'ALLOW';
          result = v.decision === 'ALLOW' ? 'Both sides verified and matched. Decision: Allow. A single-use permit was issued for these exact terms.'
            : `Decision: ${v.decision[0]}${v.decision.slice(1).toLowerCase()}. ${reasonText(v, 'buyer')?.text ?? ''}`;
          break;
        }
        case 'review':
        case 'approve_if_asked': {
          actor = 'BUYER_ORG';
          if (!txId) throw new Error('There is no transaction to review.');
          const r = await approveReview({ db, publicUrl: ctx.publicUrl }, world.ws, txId, { id: world.user, name: step.approver });
          permit = r.permit?.jws ?? permit;
          ok = r.decision === 'ALLOW';
          const v = transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId));
          code = ok ? null : reasonText(v)?.code ?? null;
          result = ok ? `${step.approver} approved these exact terms with ${WORLD.organizations.find((o) => o.role === 'BUYER')!.name}’s key. Decision: Allow, permit issued.` : `Still ${r.decision}. ${reasonText(v)?.text ?? ''}`;
          break;
        }
        case 'recheck': {
          actor = 'PROXYPROOF';
          if (!txId) throw new Error('There is no transaction to check.');
          const r = await recheck({ db, publicUrl: ctx.publicUrl }, world.ws, txId, { type: 'SYSTEM' });
          permit = r.permit?.jws ?? permit;
          ok = r.decision === 'ALLOW';
          const v = transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId));
          code = ok ? null : reasonText(v)?.code ?? null;
          result = ok ? 'Checked again on live state: Allow. A permit was issued.' : `Still ${r.decision}. ${reasonText(v)?.text ?? ''}`;
          break;
        }
        case 'execute': {
          actor = 'EXECUTOR';
          if (!txId) throw new Error('There is no transaction to pay.');
          const use = step.permit === 'none' ? undefined : step.permit === 'reuse' ? spent ?? permit : permit;
          const r = await ctx.api('POST', `/api/v1/workspaces/${world.ws}/transactions/${txId}/execute`, { permit: use });
          http = r.status;
          if (step.permit !== 'reuse' && use) spent = use;
          ok = r.status >= 200 && r.status < 300;
          code = ok ? null : r.json?.code ?? null;
          const v = transactionView(db, one<any>(db, 'SELECT * FROM commerce_transactions WHERE id = ?', txId));
          result = ok ? (v.payment?.provider_ref ? `Permit accepted and both sides re-checked live. PayPal sandbox order ${v.payment.provider_ref} created; the buyer approves on PayPal.` : 'Permit accepted. Checkout opened.')
            : (r.json?.error ?? 'The executor refused.');
          break;
        }
      }
    } catch (e: any) {
      ok = false; result = e?.message ?? 'The step could not run.'; code = e?.code ?? null;
    }
    steps.push({ n: steps.length + 1, do: step.do, actor, say: step.say, ok, result, code, http_status: http, ...snapshot() });
    // Once ProxyProof denies the transaction, the agents have nothing left to do: the run ends there.
    if (!ok && ['offer', 'revise', 'accept'].includes(step.do) && steps[steps.length - 1].tx?.decision === 'DENY') { i = sc.steps.length; break; }
  }


  const last = steps[steps.length - 1];
  // Where ProxyProof intervened. If the last step still failed, the run was stopped there; if a later step went through
  // (a person approved, the status service came back), the run was paused and then cleared.
  const stops = steps.filter((s) => !s.ok).map((s) => ({ step: s.n, do: s.do, actor: s.actor, code: s.code, result: s.result, decision: s.tx?.decision ?? null }));
  const finished = !awaiting;
  const caught = finished && last && !last.ok ? stops[stops.length - 1] : null;
  const out: any = {
    id: runId ?? newId('run'), scenario: publicScenario(sc), workspace_id: world.ws, transaction_id: txId, created_at: nowIso(),
    steps, awaiting, finished,
    outcome: {
      decision: last?.tx?.decision ?? null, payment_state: last?.tx?.payment_state ?? 'NOT_STARTED', payment: last?.tx?.payment ?? null,
      reasons: last?.tx?.reasons ?? [], stops, caught_at: caught, cleared_after: finished && !caught && stops.length ? stops[0] : null,
      money_moved: last?.tx?.payment_state === 'COMPLETED',
    },
  };
  const stored = JSON.stringify({ ...out, _state: { ...st, txId, permit, spent, next: i } });
  if (runId) run(db, 'UPDATE lab_runs SET result = ? WHERE id = ?', stored, runId);
  else run(db, 'INSERT INTO lab_runs (id, owner_workspace_id, workspace_id, scenario_id, result, created_at) VALUES (?,?,?,?,?,?)', out.id, ownerWorkspace, world.ws, sc.id, stored, out.created_at);
  return out;
}

/** A stored run for its owner, refreshed with the transaction's current payment state. */
export async function getRun(ctx: LabCtx, ownerWorkspace: string, runId: string, opts: { sync?: boolean } = {}) {
  const row = one<any>(ctx.db, 'SELECT * FROM lab_runs WHERE id = ? AND owner_workspace_id = ?', runId, ownerWorkspace);
  if (!row) throw new NotFound('Unknown run.');
  const out = J<any>(row.result, {});
  delete out._state;
  if (out.transaction_id) {
    if (opts.sync) await syncPayment(ctx.executor, row.workspace_id, out.transaction_id).catch(() => {});
    const v = transactionView(ctx.db, one<any>(ctx.db, 'SELECT * FROM commerce_transactions WHERE id = ?', out.transaction_id));
    out.current = { tx: v };
    out.outcome.payment_state = v.payment_state; out.outcome.payment = v.payment; out.outcome.money_moved = v.payment_state === 'COMPLETED';
  }
  return out;
}

/** After the buyer approved on PayPal: capture, which re-verifies both sides first. */
export async function captureRun(ctx: LabCtx, ownerWorkspace: string, runId: string) {
  const row = one<any>(ctx.db, 'SELECT * FROM lab_runs WHERE id = ? AND owner_workspace_id = ?', runId, ownerWorkspace);
  if (!row) throw new NotFound('Unknown run.');
  const out = J<any>(row.result, {});
  await captureCheckout(ctx.executor, row.workspace_id, out.transaction_id, { type: 'USER', id: 'scenario-operator' });
  return getRun(ctx, ownerWorkspace, runId);
}

export const listRuns = (db: DB, ownerWorkspace: string) => all<any>(db, 'SELECT id, scenario_id, result, created_at FROM lab_runs WHERE owner_workspace_id = ? ORDER BY created_at DESC LIMIT 30', ownerWorkspace)
  .map((r) => { const o = J<any>(r.result, {}); return { id: r.id, scenario_id: r.scenario_id, created_at: r.created_at, decision: o.outcome?.decision ?? null, caught_at: o.outcome?.caught_at ?? null }; });

export function publicScenario(sc: Scenario) {
  return { id: sc.id, title: sc.title, kind: sc.kind, story: sc.story, without: sc.without, real_world: sc.realWorld, cast: sc.cast, prompt: sc.prompt, complication: sc.complication, steps: sc.steps.filter((s) => s.do !== 'approve_if_asked').map((s) => ({ do: s.do, say: s.say })) };
}
const priceOf = (lines: [string, number][]) => lines.reduce((t, [n, q]) => t + q * PRODUCTS.find((x) => x.name === n)!.unit_amount_minor, 0);
export const listScenarios = () => ({
  world: { product: WORLD.product, organizations: WORLD.organizations.map(({ name, role, enrolled }) => ({ name, role, enrolled })) },
  products: PRODUCTS.map((p) => ({ ...p, price: formatMinor(p.unit_amount_minor) })),
  prompts: PROMPTS.map((p) => ({ id: p.id, kind: p.kind, prompt: p.prompt, title: p.title, summary: p.summary, reference: p.reference, document: p.document, total: formatMinor(priceOf(p.lines)), lines: p.lines.map(([name, quantity]) => ({ name, quantity, price: formatMinor(PRODUCTS.find((x) => x.name === name)!.unit_amount_minor) })) })),
  complications: COMPLICATIONS.map((c) => ({ id: c.id, kind: c.kind, title: c.title, story: c.story, without: c.without, real_world: c.realWorld, applies_to: c.appliesTo ?? null })),
  // The planned steps of every combination, so the dashboard can show what is about to happen before a run.
  plans: Object.fromEntries(PROMPTS.flatMap((p) => COMPLICATIONS.map((c) => compose(p.id, c.id)).filter(Boolean).map((sc) => [sc!.id, sc!.steps.filter((x) => x.do !== 'approve_if_asked').map((x) => ({ do: x.do, actor: PLAN_ACTOR[x.do], say: x.say }))]))),
});
const PLAN_ACTOR: Record<string, string> = { offer: 'SELLER_AGENT', revise: 'SELLER_AGENT', accept: 'BUYER_AGENT', review: 'BUYER_ORG', approve_if_asked: 'BUYER_ORG', revoke: 'BUYER_ORG', status: 'WORLD', recheck: 'PROXYPROOF', execute: 'EXECUTOR' };
