import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, money, toMinor, when } from '../api';
import { Monogram } from '../Monogram';
import { useMe } from '../main';
import { Chip, Modal, PERSPECTIVE, Question, usePrefersReducedMotion } from '../ui';

type Mode = 'BUYER' | 'SELLER';
type Line = [string, number];
type Step =
  | { do: 'offer'; agent: string; buyer?: string; items: Line[]; document?: 'QUOTE' | 'INVOICE'; behaviour?: string; pay_to?: string }
  | { do: 'revise'; items: Line[] }
  | { do: 'accept'; agent: string; behaviour?: string }
  | { do: 'execute' } | { do: 'execute_again' } | { do: 'execute_no_permit' }
  | { do: 'status'; up: boolean } | { do: 'recheck' };
type Scenario = { n: string; label: string; steps: Step[] };

const SALES = 'Harbor & Pine Sales Agent', PROC = 'Northwind Procurement Agent', COFFEE: Line[] = [['House Blend, 5 lb', 2]];
/** The plan's scenarios. Each is a sequence of real agent actions; the server decides every outcome. */
const SCENARIOS: Scenario[] = [
  { n: '1', label: 'Both sides valid', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: PROC }, { do: 'execute' }] },
  { n: '2', label: 'Seller agent not authorized to invoice', steps: [{ do: 'offer', agent: 'Harbor & Pine Support Agent', items: COFFEE }, { do: 'accept', agent: PROC }] },
  { n: '3', label: 'Buyer agent over its limit', steps: [{ do: 'offer', agent: SALES, items: [['Espresso machine', 1]] }, { do: 'accept', agent: PROC }] },
  { n: '3b', label: 'Above approval threshold (review)', steps: [{ do: 'offer', agent: SALES, items: [['Burr grinder', 1], ['House Blend, 5 lb', 1]] }, { do: 'accept', agent: PROC }] },
  { n: '4', label: 'Same owner, research-only agent', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: 'Northwind Research Agent' }] },
  { n: '5', label: 'Terms changed after approval', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: PROC }, { do: 'revise', items: [['House Blend, 5 lb', 4]] }, { do: 'execute_again' }] },
  { n: '5b', label: 'Buyer agent signs different terms', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: PROC, behaviour: 'sign_different_terms' }] },
  { n: '6', label: 'Wrong payment destination', steps: [{ do: 'offer', agent: SALES, items: COFFEE, pay_to: 'billing@harb0r-pine.example' }, { do: 'accept', agent: PROC }] },
  { n: '7', label: 'Revoked seller agent', steps: [{ do: 'offer', agent: 'Harbor & Pine Legacy Agent', items: COFFEE }, { do: 'accept', agent: PROC }] },
  { n: '7b', label: 'Expired buyer delegation', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: 'Northwind Events Agent' }] },
  { n: '8', label: 'Seller signature invalid', steps: [{ do: 'offer', agent: SALES, items: COFFEE, behaviour: 'wrong_key_signature' }, { do: 'accept', agent: PROC }] },
  { n: '8b', label: 'Impostor claiming the seller', steps: [{ do: 'offer', agent: SALES, items: COFFEE, behaviour: 'unregistered_key' }, { do: 'accept', agent: PROC }] },
  { n: '9', label: 'Replay and double execution', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: PROC }, { do: 'execute' }, { do: 'execute_again' }] },
  { n: '11', label: 'Status service unavailable', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'status', up: false }, { do: 'accept', agent: PROC }, { do: 'status', up: true }, { do: 'recheck' }] },
  { n: '12', label: 'Direct execution without a permit', steps: [{ do: 'offer', agent: SALES, items: COFFEE }, { do: 'accept', agent: PROC }, { do: 'execute_no_permit' }] },
  { n: 'U', label: 'Seller business not enrolled', steps: [{ do: 'offer', agent: 'Bayside Sales Agent', items: COFFEE, pay_to: 'payments@bayside.example' }, { do: 'accept', agent: PROC }] },
];
const BEHAVIOUR_LABEL: Record<string, string> = {
  honest: 'Honest', tamper_after_signing: 'Terms altered after signing', sign_different_terms: 'Signs different terms', replay: 'Sends the same request twice', omit_delegation: 'Presents no delegation',
  self_signed_delegation: 'Signs its own delegation', forged_delegation: 'Forges the organization’s signature', foreign_issuer: 'Delegation from another issuer', wrong_key_signature: 'Signs with the wrong key',
  stale_request: 'Sends an old request', unregistered_key: 'Unknown key claiming the business', unsigned: 'Sends no signature',
};
const SELLER_BEHAVIOURS = ['honest', 'tamper_after_signing', 'replay', 'omit_delegation', 'self_signed_delegation', 'forged_delegation', 'foreign_issuer', 'wrong_key_signature', 'stale_request', 'unregistered_key', 'unsigned'];
const BUYER_BEHAVIOURS = ['honest', 'sign_different_terms', 'replay', 'omit_delegation', 'self_signed_delegation', 'forged_delegation', 'wrong_key_signature', 'unregistered_key'];
const PLATFORMS: { name: string; support: 'Live' | 'Public URL needed' | 'Documented' | 'API key'; how: string }[] = [
  { name: 'Claude Code', support: 'Live', how: 'Remote MCP over Streamable HTTP on localhost, with your connection token as a header.' },
  { name: 'Claude.ai / Claude Desktop', support: 'Public URL needed', how: 'Custom connector. Anthropic’s cloud connects to it, so ProxyProof must be reachable on a public HTTPS URL.' },
  { name: 'ChatGPT / Dots', support: 'Public URL needed', how: 'Custom MCP server in developer mode, on eligible plans; Dots uses the connectors in your ChatGPT account. Write actions may need your confirmation.' },
  { name: 'OpenAI Agents API / SDK', support: 'API key', how: 'MCP tool with server_url and authorization (needs a public URL), or the Agents SDK pointed at localhost.' },
  { name: 'Grok', support: 'Public URL needed', how: 'Custom connector or the xAI API remote MCP tool. No built-in tool approval in the API.' },
  { name: 'Gemini', support: 'API key', how: 'Interactions API remote MCP (preview, public URL) or the Gemini SDK / ADK with an MCP session on localhost.' },
  { name: 'Other MCP client', support: 'Live', how: 'Any Streamable HTTP MCP client (MCP Inspector, Cursor, LangChain adapters) with the token header.' },
  { name: 'Custom agent (REST)', support: 'Live', how: 'Your agent holds its own Ed25519 key and signs every request. Highest assurance.' },
];
const Tick = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const Cross = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>;
const Pause = () => <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.3 3v6M7.7 3v6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>;

export function Dashboard() {
  const nav = useNavigate();
  const { refresh } = useMe();
  const [params, setParams] = useSearchParams();
  const mode: Mode = params.get('view') === 'SELLER' ? 'SELLER' : 'BUYER';
  const action = mode === 'BUYER' ? 'COLLECT' : 'MAKE';
  const [st, setSt] = useState<any>(null);
  const [txs, setTxs] = useState<any[]>([]);
  const [tx, setTx] = useState<any>(null);
  const [permit, setPermit] = useState<any>(null);
  const [log, setLog] = useState<{ t: string; ok: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'agents' | 'connect' | 'evidence' | 'api' | 'audit'>(null);
  const [delegateFor, setDelegateFor] = useState<any>(null);
  const [sellerAgent, setSellerAgent] = useState(''), [buyerAgent, setBuyerAgent] = useState(''), [buyerOrg, setBuyerOrg] = useState('');
  const [doc, setDoc] = useState<'QUOTE' | 'INVOICE'>('INVOICE');
  const [qty, setQty] = useState<Record<string, number>>({ 'House Blend, 5 lb': 2 });
  const [payTo, setPayTo] = useState('');
  const [sb, setSb] = useState('honest'), [bb, setBb] = useState('honest');

  const load = async () => {
    try { const [s, t] = await Promise.all([api.get('/api/state'), api.get('/api/transactions')]); setSt(s); setTxs(t.transactions); setError(null); return s; }
    catch (e: any) { setError(e.message); return null; }
  };
  useEffect(() => { load().then((s) => {
    if (!s) return;
    const byName = (n: string) => s.agents.find((a: any) => a.name === n)?.id ?? '';
    setSellerAgent(byName(SALES)); setBuyerAgent(byName(PROC));
    setBuyerOrg(s.organizations.find((o: any) => o.name === 'Northwind Hotels')?.id ?? '');
    setPayTo(s.paypal.seller_account);
    const id = params.get('tx'); if (id) api.get(`/api/transactions/${id}`).then(setTx).catch(() => {});
  }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const agents = st?.agents ?? [];
  const agentByName = (n: string) => agents.find((a: any) => a.name === n);
  const lines = (st?.catalog ?? []).filter((c: any) => (qty[c.name] ?? 0) > 0).map((c: any) => ({ name: c.name, category: c.category, quantity: qty[c.name], unit_amount_minor: c.unit_amount_minor }));
  const toLines = (l: Line[]) => l.map(([n, q]) => { const c = st.catalog.find((x: any) => x.name === n); return { name: c.name, category: c.category, quantity: q, unit_amount_minor: c.unit_amount_minor }; });
  const note = (t: string, ok = true) => setLog((l) => [...l.slice(-7), { t, ok }]);
  const refreshTx = async (id: string) => { const v = await api.get(`/api/transactions/${id}`); setTx(v); return v; };
  const firstHard = (r: any) => r.reasons?.find((x: any) => x.state !== 'hold') ?? r.reasons?.[0];

  // ---- Real agent actions, all through the public API via the labelled test runtime ----
  const doOffer = async (o: { agentId: string; buyerOrgId: string; items: any[]; document: string; behaviour: string; pay_to: string; transaction_id?: string }) => {
    const r = await api.post('/api/runtime/offer', { agent_id: o.agentId, buyer_org_id: o.buyerOrgId, behaviour: o.behaviour, transaction_id: o.transaction_id, draft: { reference: `${o.document === 'QUOTE' ? 'Q' : 'INV'}-${Math.floor(1000 + Math.random() * 9000)}`, document: o.document, currency: 'USD', items: o.items, payment_destination: o.pay_to } });
    if (!o.transaction_id) setPermit(null);
    const h = firstHard(r);
    note(`${o.transaction_id ? 'Seller’s agent revised the terms' : 'Seller’s agent sent the offer'}: ${r.decision}${h ? ` (${h.code})` : ''}`, r.decision !== 'DENY');
    return refreshTx(r.transaction_id);
  };
  const doAccept = async (id: string, agentId: string, behaviour: string) => {
    const r = await api.post('/api/runtime/accept', { agent_id: agentId, transaction_id: id, behaviour });
    if (r.permit) setPermit(r.permit);
    const h = firstHard(r);
    note(`Buyer’s agent signed acceptance: ${r.decision}${h ? ` (${h.code})` : ''}${r.permit ? ', permit issued' : ''}`, r.decision === 'ALLOW');
    return { view: await refreshTx(id), permit: r.permit ?? null };
  };
  const doExecute = async (id: string, p: any) => {
    try { await api.post('/api/runtime/execute', { transaction_id: id, permit: p?.jws }); note('Executor admitted the permit and opened the PayPal checkout', true); }
    catch (e: any) { note(`Executor refused: ${e.code ?? ''} ${e.message}`, false); }
    return refreshTx(id);
  };

  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(null); try { await fn(); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const runScenario = (s: Scenario) => run(async () => {
    setLog([]); setTx(null); setPermit(null);
    let current: any = null, p: any = null;
    for (const step of s.steps) {
      if (step.do === 'offer') {
        const a = agentByName(step.agent), org = st.organizations.find((o: any) => o.name === (step.buyer ?? 'Northwind Hotels'));
        current = await doOffer({ agentId: a.id, buyerOrgId: org.id, items: toLines(step.items), document: step.document ?? 'INVOICE', behaviour: step.behaviour ?? 'honest', pay_to: step.pay_to ?? st.paypal.seller_account });
      } else if (step.do === 'revise') {
        current = await doOffer({ agentId: agentByName(SALES).id, buyerOrgId: current.buyer.organization.id, items: toLines(step.items), document: 'INVOICE', behaviour: 'honest', pay_to: st.paypal.seller_account, transaction_id: current.id });
      } else if (step.do === 'accept') {
        const r = await doAccept(current.id, agentByName(step.agent).id, step.behaviour ?? 'honest'); current = r.view; p = r.permit;
      } else if (step.do === 'execute') { current = await doExecute(current.id, p); }
      else if (step.do === 'execute_again') { note(`Re-using the earlier permit${current.version > 1 ? ' after the terms changed' : ''}…`); current = await doExecute(current.id, p); }
      else if (step.do === 'execute_no_permit') { note('Calling the executor directly, without a permit…'); current = await doExecute(current.id, null); }
      else if (step.do === 'status') { await api.post('/api/settings/status-service', { up: step.up }); note(`Revocation status service ${step.up ? 'restored' : 'taken offline'}`, step.up); }
      else if (step.do === 'recheck') { const r = await api.post(`/api/transactions/${current.id}/recheck`); if (r.permit) { setPermit(r.permit); p = r.permit; } note(`Checked again: ${r.decision}`, r.decision === 'ALLOW'); current = await refreshTx(current.id); }
      await new Promise((r) => setTimeout(r, 700));
    }
  });

  const leave = async () => { await api.post('/api/auth/logout').catch(() => {}); await refresh(); nav('/'); };
  const switchMode = (m: Mode) => { const p = new URLSearchParams(params); p.set('view', m); setParams(p, { replace: true }); };

  if (!st) return <div className="splash">{error ? <p className="notice error">{error}</p> : <Monogram size={72} animate />}</div>;
  const evaluatedSide = mode === 'BUYER' ? 'seller' : 'buyer';
  const evaluated = tx ? tx[evaluatedSide] : null;
  const evaluatedAgent = evaluated?.agent?.id ? agents.find((a: any) => a.id === evaluated.agent.id) : (evaluated?.agent ? null : agents.find((a: any) => a.id === (mode === 'BUYER' ? sellerAgent : buyerAgent)));
  const receiver = mode === 'BUYER' ? (tx?.buyer?.organization?.name ?? st.organizations.find((o: any) => o.id === buyerOrg)?.name) : (tx?.seller?.organization?.name ?? 'Harbor & Pine Roasters');
  const pendingApprovals = agents.filter((a: any) => a.pending).length;

  return (
    <div className="dash">
      <header className="top"><div className="top-inner">
        <Link className="brand" to="/"><Monogram size={28} />ProxyProof</Link>
        <div className="seg" role="group" aria-label="Viewpoint">
          {(['BUYER', 'SELLER'] as Mode[]).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => switchMode(m)}>{m} VIEW</button>)}
        </div>
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={() => setModal('connect')}>Connect an agent</button>
        <button className="btn btn-quiet btn-sm" onClick={() => setModal('agents')}>Agents{pendingApprovals ? ` (${pendingApprovals} to approve)` : ''}</button>
        <button className="btn btn-quiet btn-sm" onClick={() => setModal('api')}>Agent API</button>
        <button className="btn btn-quiet btn-sm" onClick={() => setModal('audit')}>Audit</button>
        <button className="btn btn-quiet btn-sm" onClick={leave}>Leave demo</button>
      </div></header>
      <main>
        <div className="dash-q"><div>
          <Question action={action} as="h1" />
          <span className="persp" style={{ marginTop: 8 }}><i />{PERSPECTIVE[action].label}</span>
          <p className="persp-text">{PERSPECTIVE[action].text}</p>
        </div></div>
        <div className="scenarios">
          <span className="group-label">Scenarios (real agents, real checks)</span>
          <div className="presets">{SCENARIOS.map((s) => <button key={s.n} className="preset" disabled={busy} onClick={() => runScenario(s)}><span className="mono tiny muted">{s.n}</span> {s.label}</button>)}</div>
        </div>
        {error && <p className="notice error" role="alert" style={{ marginBottom: 12 }}>{error}</p>}

        <div className="stage grid-bg">
          <EvaluatedAgent side={evaluatedSide} agent={evaluatedAgent} view={evaluated} orgs={st.organizations} other={tx ? tx[evaluatedSide === 'seller' ? 'buyer' : 'seller'] : null} />

          <section className="col" aria-labelledby="terms-h">
            <div className="col-h"><h2 id="terms-h">TRANSACTION</h2>{tx && <span className="tiny muted mono">{tx.id} · v{tx.version}</span>}</div>
            {tx?.terms ? <TermsCard tx={tx} /> : <p className="small muted">No transaction yet. Run a scenario, or use the two agent steps below.</p>}
            <details className="doc" open={!tx}>
              <summary><strong>1. Seller’s agent sends a {doc.toLowerCase()}</strong></summary>
              <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                <label className="field">Seller agent<select className="input" value={sellerAgent} onChange={(e) => setSellerAgent(e.target.value)}>{agents.filter((a: any) => a.side === 'SELLER').map((a: any) => <option key={a.id} value={a.id}>{a.name} · {a.state.toLowerCase().replace('_', ' ')}</option>)}</select></label>
                <div className="row"><label className="field" style={{ flex: 1 }}>To buyer<select className="input" value={buyerOrg} onChange={(e) => setBuyerOrg(e.target.value)}>{st.organizations.filter((o: any) => o.role === 'BUYER').map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
                  <label className="field">Document<select className="input" value={doc} onChange={(e) => setDoc(e.target.value as any)}><option value="INVOICE">Invoice</option><option value="QUOTE">Quote</option></select></label></div>
                <div className="line-items">{st.catalog.map((c: any) => (
                  <label key={c.name} className="line-item"><input type="checkbox" checked={(qty[c.name] ?? 0) > 0} onChange={(e) => setQty({ ...qty, [c.name]: e.target.checked ? 1 : 0 })} /><span>{c.name}</span><span className="small muted">{c.price}</span>
                    <input className="input" type="number" min={0} max={50} aria-label={`Quantity of ${c.name}`} value={qty[c.name] ?? 0} onChange={(e) => setQty({ ...qty, [c.name]: Math.max(0, Number(e.target.value) || 0) })} /></label>
                ))}</div>
                <label className="field">Pay to<input className="input" value={payTo} onChange={(e) => setPayTo(e.target.value)} /></label>
                <label className="field">Agent behaviour<select className="input" value={sb} onChange={(e) => setSb(e.target.value)}>{SELLER_BEHAVIOURS.map((b) => <option key={b} value={b}>{BEHAVIOUR_LABEL[b]}</option>)}</select></label>
                <div className="row">
                  <button className="btn btn-primary btn-sm" disabled={busy || !lines.length} onClick={() => run(async () => { setLog([]); await doOffer({ agentId: sellerAgent, buyerOrgId: buyerOrg, items: lines, document: doc, behaviour: sb, pay_to: payTo }); })}>Send as new transaction</button>
                  {tx && tx.payment_state === 'NOT_STARTED' && <button className="btn btn-secondary btn-sm" disabled={busy || !lines.length} onClick={() => run(async () => { await doOffer({ agentId: sellerAgent, buyerOrgId: buyerOrg, items: lines, document: doc, behaviour: sb, pay_to: payTo, transaction_id: tx.id }); })}>Revise this transaction’s terms</button>}
                </div>
              </div>
            </details>
            <details className="doc" open={Boolean(tx) && !tx?.buyer?.agent}>
              <summary><strong>2. Buyer’s agent authorizes these terms</strong></summary>
              <div className="stack" style={{ gap: 8, marginTop: 8 }}>
                <label className="field">Buyer agent<select className="input" value={buyerAgent} onChange={(e) => setBuyerAgent(e.target.value)}>{agents.filter((a: any) => a.side === 'BUYER').map((a: any) => <option key={a.id} value={a.id}>{a.name} · {a.state.toLowerCase().replace('_', ' ')}</option>)}</select></label>
                <label className="field">Agent behaviour<select className="input" value={bb} onChange={(e) => setBb(e.target.value)}>{BUYER_BEHAVIOURS.map((b) => <option key={b} value={b}>{BEHAVIOUR_LABEL[b]}</option>)}</select></label>
                <button className="btn btn-primary btn-sm" disabled={busy || !tx} onClick={() => run(async () => { await doAccept(tx.id, buyerAgent, bb); })}>Buyer’s agent signs acceptance</button>
              </div>
            </details>
            {log.length > 0 && <ol className="runlog">{log.map((l, i) => <li key={i} className={l.ok ? '' : 'bad'}>{l.t}</li>)}</ol>}
            <p className="tiny muted">Test agents are labelled. Each signs with its own key and calls the public API, the same one external agents use. The dashboard cannot set an outcome.</p>
          </section>

          <VerificationLayer tx={tx} mode={mode} busy={busy} statusUp={st.workspace.status_service === 'UP'} onToggle={() => run(async () => { await api.post('/api/settings/status-service', { up: st.workspace.status_service !== 'UP' }); })} />

          <section className="col recv-col" aria-labelledby="recv-h" style={{ background: '#fff' }}>
            <div className="col-h"><h2 id="recv-h">{(receiver ?? 'RECEIVER').toUpperCase()} {mode === 'BUYER' ? 'RECEIVES THE INVOICE' : 'RECEIVES THE PURCHASE'}</h2></div>
            <Decision tx={tx} mode={mode} permit={permit} busy={busy} paypal={st.paypal}
              onReview={() => run(async () => { const r = await api.post(`/api/transactions/${tx.id}/review`); if (r.permit) setPermit(r.permit); note(`${tx.buyer.organization.name} approved the exact terms: ${r.decision}`, r.decision === 'ALLOW'); await refreshTx(tx.id); })}
              onRecheck={() => run(async () => { const r = await api.post(`/api/transactions/${tx.id}/recheck`); if (r.permit) setPermit(r.permit); note(`Checked again: ${r.decision}`, r.decision === 'ALLOW'); await refreshTx(tx.id); })}
              onExecute={() => run(async () => { await doExecute(tx.id, permit); })}
              onExecuteNoPermit={() => run(async () => { note('Calling the executor directly, without a permit…'); await doExecute(tx.id, null); })}
              onCapture={() => run(async () => { try { await api.post(`/api/transactions/${tx.id}/capture`); note('Capture requested; status read from PayPal'); } catch (e: any) { note(`${e.code ?? ''} ${e.message}`, false); } await refreshTx(tx.id); })}
              onSync={() => run(async () => { await api.post(`/api/transactions/${tx.id}/sync`); await refreshTx(tx.id); })}
              onEvidence={() => setModal('evidence')} />
          </section>
        </div>

        <section className="activity" aria-labelledby="act-h">
          <div className="row" style={{ justifyContent: 'space-between' }}><h2 id="act-h">Transactions</h2><span className="small muted">{txs.length} recorded · audit chain {st.chain.ok ? 'intact' : 'broken'}</span></div>
          <div className="tx-list">
            {txs.length ? txs.map((t) => (
              <button key={t.id} className="tx" aria-current={tx?.id === t.id} onClick={() => { setTx(t); setPermit(null); setLog([]); }}>
                <Chip v={t.decision} />
                <span className="small">{t.seller.agent?.name ?? 'Unknown'} → {t.buyer.agent?.name ?? 'awaiting buyer'}</span>
                <span className="why">{t.reasons.find((r: any) => r.state !== 'hold')?.message ?? t.reasons[0]?.message ?? `${t.document} ${t.reference}`}</span>
                <span>{t.amount ?? ''}</span>
                <span className="when small muted"><Chip v={t.payment_state} /></span>
              </button>
            )) : <div className="empty-note">No transactions yet. Pick a scenario above.</div>}
          </div>
        </section>
      </main>
      <footer className="foot"><div className="foot-inner"><span>Sandbox demo. Payments use the PayPal sandbox and move no real money.</span><span>Not affiliated with PayPal or any agent platform.</span></div></footer>

      {modal === 'agents' && <AgentsModal st={st} onClose={() => setModal(null)} onChange={load} onDelegate={(a: any) => setDelegateFor(a)} onConnect={() => setModal('connect')} />}
      {modal === 'connect' && <ConnectWizard st={st} onClose={() => setModal(null)} onDone={async () => { await load(); }} onDelegate={(a: any) => setDelegateFor(a)} />}
      {delegateFor && <Delegate agent={delegateFor} st={st} onClose={() => setDelegateFor(null)} onDone={async () => { setDelegateFor(null); await load(); }} />}
      {modal === 'evidence' && tx && <Evidence tx={tx} ws={st.workspace.id} onClose={() => setModal(null)} />}
      {modal === 'api' && <ApiInfo st={st} onClose={() => setModal(null)} />}
      {modal === 'audit' && <Audit onClose={() => setModal(null)} />}
    </div>
  );
}

function EvaluatedAgent({ side, agent, view, orgs, other }: any) {
  const d = agent?.delegation, m = d?.mandate;
  const name = (did: string) => orgs.find((o: any) => o.did === did)?.name ?? `${did.slice(0, 14)}…`;
  const unknown = view?.agent && !view.agent.id;
  return (
    <section className="col" style={{ background: '#fff' }} aria-labelledby="ev-h">
      <div className="col-h"><h2 id="ev-h">{side === 'seller' ? 'SELLER’S AGENT' : 'BUYER’S AGENT'}</h2></div>
      {unknown ? <div className="agent-detail"><strong>Unknown agent</strong><span className="small">Key {view.agent.did?.slice(0, 24)}… is not registered by any organization.</span><Chip v="DENY" /></div>
        : agent ? <div className="agent-detail">
          <div className="row" style={{ justifyContent: 'space-between' }}><strong style={{ fontSize: 14 }}>{agent.name}</strong><Chip v={agent.state} /></div>
          <dl className="kv">
            <dt>Acts for</dt><dd>{orgs.find((o: any) => o.id === agent.principal_id)?.name}</dd>
            <dt>Created in</dt><dd>{agent.provider}</dd>
            <dt>Connected by</dt><dd>{agent.connection === 'TEST_RUNTIME' ? 'Test runtime (labelled)' : agent.connection}</dd>
            <dt>Assurance</dt><dd className="small">{agent.assurance}</dd>
            <dt>Key</dt><dd className="mono">{agent.did.slice(0, 20)}…</dd>
            {m && <>
              <dt>May</dt><dd>{m.actions.join(', ').replace(/_/g, ' ')}</dd>
              <dt>Limit</dt><dd>{money(m.max_amount_minor)}{m.step_up_above_minor ? `, review above ${money(m.step_up_above_minor)}` : ''}</dd>
              <dt>Categories</dt><dd>{m.categories.join(', ')}</dd>
              <dt>With</dt><dd>{m.counterparties.length ? m.counterparties.map(name).join(', ') : 'Any enrolled organization'}</dd>
              {m.destinations?.length ? <><dt>Paid to</dt><dd>{m.destinations.join(', ')}</dd></> : null}
              <dt>{d.status === 'REVOKED' ? 'Revoked' : 'Valid until'}</dt><dd>{d.status === 'REVOKED' ? `${when(d.revoked_at)}${d.revoked_reason ? `. ${d.revoked_reason}` : ''}` : new Date(d.valid_until).toLocaleDateString()}</dd>
            </>}
            {!m && <><dt>Authority</dt><dd>None. Connected is not authorized.</dd></>}
          </dl>
        </div> : <p className="small muted">Choose an agent.</p>}
      {other?.agent && <div className="other-side">
        <span className="group-label">Other side</span>
        <span className="small"><strong>{other.agent.name}</strong> for {other.organization?.name ?? 'unknown'}</span>
        <span className="tiny muted">Verified independently on the green line.</span>
      </div>}
    </section>
  );
}

function TermsCard({ tx }: any) {
  const t = tx.terms;
  return (
    <div className="doc terms">
      <div className="doc-h"><h3>{t.document === 'INVOICE' ? 'Invoice' : 'Quote'} {t.reference}</h3><span className="small muted">{tx.seller.organization?.name ?? '?'} → {tx.buyer.organization?.name ?? '?'}</span></div>
      <div className="line-items">{t.items.map((i: any, n: number) => <div key={n} className="row small" style={{ justifyContent: 'space-between' }}><span>{i.quantity} × {i.name}</span><span>{money(i.quantity * i.unit_amount_minor, t.currency)}</span></div>)}</div>
      <div className="total"><span>Total</span><span>{money(t.total_minor, t.currency)}</span></div>
      <dl className="kv"><dt>Pay to</dt><dd>{t.payment_destination}</dd><dt>Open until</dt><dd>{when(t.expires_at)}</dd><dt>Terms hash</dt><dd className="mono">{tx.terms_hash?.slice(0, 24)}…</dd></dl>
      {tx.history?.length > 0 && <p className="tiny muted">Revised: earlier version{tx.history.length > 1 ? 's' : ''} {tx.history.map((h: any) => `v${h.version} (${money(h.amount_minor)})`).join(', ')} superseded. Earlier authorizations no longer apply.</p>}
    </div>
  );
}

/** Reveals the server's recorded checks group by group. The states come from the backend; only the pacing is visual. */
function VerificationLayer({ tx, mode, busy, statusUp, onToggle }: any) {
  const reduce = usePrefersReducedMotion();
  const groups = useMemo(() => {
    if (!tx) return [];
    const seller = { key: 'seller', title: 'Seller’s agent authority', checks: tx.seller.checks };
    const buyer = { key: 'buyer', title: 'Buyer’s agent authority', checks: tx.buyer.checks.length ? tx.buyer.checks : [{ key: 'pending', label: 'Waiting for the buyer’s agent', state: 'hold', detail: 'No acceptance yet.' }] };
    const match = { key: 'match', title: 'Same transaction, policy', checks: tx.match };
    return mode === 'BUYER' ? [seller, buyer, match] : [buyer, seller, match];
  }, [tx, mode]);
  const total = groups.reduce((n: number, g: any) => n + g.checks.length, 0);
  const [shown, setShown] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (timer.current) window.clearInterval(timer.current);
    if (!tx) { setShown(0); return; }
    if (reduce) { setShown(total); return; }
    setShown(0); let n = 0;
    timer.current = window.setInterval(() => { n++; setShown(n); if (n >= total && timer.current) window.clearInterval(timer.current); }, 90);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [tx?.id, tx?.updated_at, mode, reduce]); // eslint-disable-line react-hooks/exhaustive-deps
  let i = 0;
  return (
    <section className="col layer" aria-labelledby="layer-h" aria-live="polite">
      <div className="col-h"><h2 id="layer-h">PROXYPROOF VERIFICATION</h2></div>
      {!tx && <p className="small muted">{busy ? 'Verifying…' : 'Every request must cross this line. Nothing reaches the receiving side or PayPal until both sides pass.'}</p>}
      {groups.map((g: any) => {
        const gs = g.checks.some((c: any) => c.state === 'fail') ? 'fail' : g.checks.some((c: any) => c.state === 'hold') ? 'hold' : g.checks.some((c: any) => c.state === 'review') ? 'review' : 'pass';
        return (
          <div key={g.key} className="vgroup">
            <div className="row" style={{ justifyContent: 'space-between' }}><strong className="small">{g.title}</strong><Chip v={gs} /></div>
            <ol className="rail">
              {g.checks.map((c: any) => { const idx = i++; const s = idx < shown ? c.state : idx === shown ? 'running' : 'idle'; return (
                <li key={`${g.key}-${c.key}`} className="cp" data-s={s}>
                  <span className="dot">{s === 'pass' ? <Tick /> : s === 'fail' ? <Cross /> : s === 'hold' || s === 'review' ? <Pause /> : null}</span>
                  <div className="lbl">{c.label}</div>
                  {idx < shown && ['fail', 'hold', 'review'].includes(c.state) && <div className="det">{c.detail}</div>}
                </li>
              ); })}
            </ol>
          </div>
        );
      })}
      <div className="layer-foot stack" style={{ gap: 6 }}>
        <span>Deterministic server-side checks. No language model takes part in the decision.</span>
        <span>Revocation status service: <strong>{statusUp ? 'online' : 'offline'}</strong> <button className="btn btn-quiet btn-sm" onClick={onToggle}>{statusUp ? 'Simulate outage' : 'Restore'}</button></span>
      </div>
    </section>
  );
}

function Decision({ tx, mode, permit, busy, paypal, onReview, onRecheck, onExecute, onExecuteNoPermit, onCapture, onSync, onEvidence }: any) {
  if (!tx) return <div className="verdict EMPTY">Nothing has arrived yet. A {mode === 'BUYER' ? 'quote or invoice' : 'purchase'} reaches this side only after crossing the verification line.</div>;
  const fail = tx.reasons.find((r: any) => r.state === 'fail'), hold = tx.reasons.find((r: any) => r.state === 'hold'), review = tx.reasons.find((r: any) => r.state === 'review');
  const evaluatedOk = (mode === 'BUYER' ? tx.seller.checks : tx.buyer.checks).length > 0 && (mode === 'BUYER' ? tx.seller.checks : tx.buyer.checks).every((c: any) => c.state === 'pass');
  const executed = tx.permits.some((p: any) => p.used_result === 'EXECUTED');
  const p = tx.payment;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className={`verdict ${tx.decision}`}>
        <div className="row" style={{ justifyContent: 'space-between' }}><div className="word">{tx.decision}</div><Chip v={tx.payment_state} /></div>
        <div className="why">
          {tx.decision === 'ALLOW' ? 'Both agents are authorized by their organizations and signed the same terms.'
            : fail ? <><strong>{fail.side === 'match' ? 'Terms' : fail.side === 'seller' ? 'Seller side' : 'Buyer side'}:</strong> {fail.message}</>
            : review ? review.message : hold?.message}
        </div>
        <div className="small">{mode === 'BUYER' ? (evaluatedOk ? 'This is a verified request from the seller’s authorized agent.' : 'This is not a verified seller request. Do not act on it.') : (evaluatedOk ? 'The buyer’s agent is authorized to make this purchase.' : 'The buyer’s agent has not shown authority for this purchase.')}</div>
      </div>
      {tx.decision === 'REVIEW' && <div className="pay"><strong>Waiting for {tx.buyer.organization?.name} to approve these exact terms.</strong><span className="small muted">Asked through the session that already speaks for the organization, never through contact details an agent supplied.</span><button className="btn btn-primary btn-sm" disabled={busy} onClick={onReview}>Approve as {tx.buyer.organization?.name}</button></div>}
      {tx.decision === 'HOLD' && tx.reasons.some((r: any) => r.code === 'STATUS_UNAVAILABLE') && <div className="pay"><span className="small">Restore the status service, then check again.</span><button className="btn btn-secondary btn-sm" disabled={busy} onClick={onRecheck}>Check again</button></div>}
      <div className="pay">
        <div className="row" style={{ justifyContent: 'space-between' }}><strong>Execution</strong><span className="tiny muted">{executed ? 'Executor called' : 'Executor not called'}</span></div>
        {tx.decision === 'ALLOW' && tx.payment_state === 'NOT_STARTED' && <>
          {permit ? <span className="small">Single-use permit <span className="mono">{permit.jti}</span> for these exact terms, valid 5 minutes.</span> : <span className="small muted">No unused permit in hand. Each permit works once.</span>}
          <div className="row"><button className="btn btn-primary btn-sm" disabled={busy || !permit} onClick={onExecute}>Open PayPal checkout with permit</button><button className="btn btn-quiet btn-sm" disabled={busy} onClick={onExecuteNoPermit}>Try without permit</button></div>
          {!paypal.configured && <span className="tiny muted">PayPal sandbox credentials are not configured here, so the executor will refuse after verifying.</span>}
        </>}
        {tx.decision !== 'ALLOW' && <><span className="small muted">No permit was issued. Nothing can be executed.</span><button className="btn btn-quiet btn-sm" disabled={busy} onClick={onExecuteNoPermit}>Try to execute anyway</button></>}
        {p && <>
          <span className="small">PayPal sandbox order <span className="mono">{p.provider_ref ?? '—'}</span>{p.provider_status ? ` · ${p.provider_status}` : ''}</span>
          {tx.payment_state === 'AWAITING_BUYER_APPROVAL' && <>{p.payer_link && <a className="btn btn-primary btn-sm" href={p.payer_link} target="_blank" rel="noreferrer">Approve as the buyer on PayPal</a>}<button className="btn btn-secondary btn-sm" disabled={busy} onClick={onCapture}>Capture after approval</button><span className="tiny muted">Authority is re-checked before capture. Paid only when PayPal confirms.</span></>}
          {tx.payment_state === 'CAPTURE_SUBMITTED' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={onSync}>Check PayPal status</button>}
          {tx.payment_state === 'COMPLETED' && <span className="small">PayPal confirmed the payment ({p.confirmed_by}).</span>}
          {p.failure && <span className="small" style={{ color: 'var(--red)' }}>{p.failure}</span>}
        </>}
      </div>
      <button className="btn btn-secondary btn-sm" onClick={onEvidence}>Inspect bilateral evidence</button>
    </div>
  );
}

function Evidence({ tx, ws, onClose }: any) {
  const [data, setData] = useState<any>(null);
  const [check, setCheck] = useState<any>(null);
  useEffect(() => { api.get(`/api/v1/workspaces/${ws}/transactions/${tx.id}/proof`).then(setData).catch((e) => setData({ error: e.message })); }, [tx.id, ws]);
  const verify = async (tamper = false) => {
    const bundle = tamper ? { ...data.bundle, transaction: { ...data.bundle.transaction, terms: { ...data.bundle.transaction.terms, total_minor: 1 } } } : data.bundle;
    setCheck({ tamper, ...(await api.post('/api/v1/proofs/verify', { bundle, signature: data.signature })) });
  };
  const download = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = `proxyproof-evidence-${tx.id}.json`; a.click(); };
  return (
    <Modal title="Bilateral evidence bundle" onClose={onClose}>
      {!data ? <p className="small muted">Building…</p> : data.error ? <p className="notice error">{data.error}</p> : <>
        <p className="small">Both authority chains as presented, every check, the term match, the decision receipt, permits and the PayPal outcome. Signed by ProxyProof over its SHA-256 (<span className="mono">{data.bundle_sha256.slice(0, 16)}…</span>).</p>
        <div className="two-col">
          {(['seller', 'buyer'] as const).map((k) => { const s = data.bundle[k]; return (
            <div key={k} className="pay"><strong>{k === 'seller' ? 'Seller chain' : 'Buyer chain'}</strong>{s ? <>
              <span className="small">{s.organization?.name ?? 'Unknown organization'} → {s.agent?.name ?? 'Unknown agent'}</span>
              <span className="tiny muted">Delegation credential: {s.delegation_credential ? `${s.delegation_credential.length} chars, signed` : 'none presented'}</span>
              <span className="tiny">{s.checks.filter((c: any) => c.state === 'pass').length}/{s.checks.length} checks passed</span></> : <span className="small muted">No acceptance yet.</span>}</div>
          ); })}
        </div>
        <dl className="kv"><dt>Decision</dt><dd>{data.bundle.decision}</dd><dt>Payment</dt><dd>{data.bundle.payment.state}{data.bundle.payment.provider_ref ? ` · ${data.bundle.payment.provider_ref}` : ''}</dd><dt>Permits</dt><dd>{data.bundle.permits.map((p: any) => `${p.jti} (${p.used_result ?? 'unused'})`).join(', ') || 'none'}</dd><dt>Audit chain</dt><dd>{data.bundle.audit_chain.ok ? 'intact' : 'broken'}, {data.bundle.audit_chain.events} events</dd></dl>
        <div className="row"><button className="btn btn-primary btn-sm" onClick={() => verify(false)}>Verify bundle</button><button className="btn btn-secondary btn-sm" onClick={() => verify(true)}>Verify a tampered copy</button><button className="btn btn-quiet btn-sm" onClick={download}>Download JSON</button></div>
        {check && <p className={`notice ${check.digest_matches && check.signature ? '' : 'error'}`}>{check.tamper ? 'Tampered copy (total changed to $0.01): ' : ''}signature {check.signature ? 'valid' : 'invalid'}, digest {check.digest_matches ? 'matches' : 'does not match'}, decision receipt {check.decision_receipt ? 'valid' : 'invalid'}.</p>}
      </>}
    </Modal>
  );
}

function AgentsModal({ st, onClose, onChange, onDelegate, onConnect }: any) {
  const [busy, setBusy] = useState(false);
  const act = async (id: string, what: string) => { setBusy(true); try { await api.post(`/api/delegations/${id}/${what}`); await onChange(); } finally { setBusy(false); } };
  return (
    <Modal title="Agents" onClose={onClose}>
      <div className="row" style={{ justifyContent: 'space-between' }}><span className="small muted">Each organization approves its own agents. Connected is not authorized.</span><button className="btn btn-primary btn-sm" onClick={onConnect}>Connect an agent</button></div>
      {st.organizations.map((o: any) => (
        <div key={o.id} className="stack" style={{ gap: 6 }}>
          <div className="group-label">{o.name} · {o.role.toLowerCase()} · {o.status === 'VERIFIED' ? 'enrolled' : 'not enrolled'}</div>
          {st.agents.filter((a: any) => a.principal_id === o.id).map((a: any) => (
            <div key={a.id} className="agent-row">
              <div><strong className="small">{a.name}</strong><div className="tiny muted">{a.provider} · {a.connection === 'TEST_RUNTIME' ? 'test runtime' : a.connection}</div></div>
              <Chip v={a.state} />
              <div className="row" style={{ gap: 4 }}>
                {a.pending && <><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(a.pending.id, 'approve')}>Approve as {o.name}</button><button className="btn btn-quiet btn-sm" disabled={busy} onClick={() => act(a.pending.id, 'decline')}>Decline</button></>}
                {a.state === 'AUTHORIZED' && <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act(a.delegation.id, 'revoke')}>Revoke</button>}
                {!a.pending && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onDelegate(a)}>{a.state === 'AUTHORIZED' ? 'Change' : 'Grant authority'}</button>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}

function ConnectWizard({ st, onClose, onDone, onDelegate }: any) {
  const [platform, setPlatform] = useState<typeof PLATFORMS[number] | null>(null);
  const [name, setName] = useState(''), [side, setSide] = useState<'BUYER' | 'SELLER'>('BUYER'), [org, setOrg] = useState('');
  const [jwk, setJwk] = useState('');
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const orgs = st.organizations.filter((o: any) => o.role === side);
  useEffect(() => { setOrg(orgs[0]?.id ?? ''); }, [side]); // eslint-disable-line react-hooks/exhaustive-deps
  const rest = platform?.name === 'Custom agent (REST)';
  const register = async () => {
    setError(null);
    try {
      const body: any = { name, side, principal_id: org, provider: platform!.name, connection: rest ? 'API' : 'MCP' };
      if (rest) body.public_jwk = JSON.parse(jwk);
      setResult(await api.post('/api/agents', body)); await onDone();
    } catch (e: any) { setError(e instanceof SyntaxError ? 'The public key must be a JSON JWK.' : e.message); }
  };
  const cmd = result?.connection_token ? `claude mcp add --transport http proxyproof ${result.mcp_url} --header "Authorization: Bearer ${result.connection_token}"` : '';
  const agent = result ? st.agents.find((a: any) => a.id === result.id) : null;
  return (
    <Modal title="Connect an agent" onClose={onClose}>
      {!platform && <>
        <p className="small">1. Where was the agent created? ProxyProof does not build agents; it verifies the ones you already have.</p>
        <div className="platforms">{PLATFORMS.map((p) => <button key={p.name} className="platform" onClick={() => setPlatform(p)}><strong>{p.name}</strong><span className={`support s-${p.support.replace(/\s/g, '')}`}>{p.support}</span><span className="tiny muted">{p.how}</span></button>)}</div>
        <p className="tiny muted">“Live” means tested against this server today. Other platforms need a public HTTPS URL or an API key; their setup is documented in docs/research/protocol-compatibility.md and is never shown as a live connection.</p>
      </>}
      {platform && !result && <div className="stack">
        <p className="small"><strong>{platform.name}</strong>: {platform.how}</p>
        <p className="small">2. Identify the agent. A name is a label, not identity: identity comes from {rest ? 'the agent’s own key' : 'the connection token ProxyProof issues'}.</p>
        <label className="field">Agent name<input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude purchasing agent" /></label>
        <div className="row"><label className="field">Side<select className="input" value={side} onChange={(e) => setSide(e.target.value as any)}><option value="BUYER">Buyer agent</option><option value="SELLER">Seller agent</option></select></label>
          <label className="field" style={{ flex: 1 }}>Acts for<select className="input" value={org} onChange={(e) => setOrg(e.target.value)}>{orgs.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label></div>
        {rest && <label className="field">Agent’s public Ed25519 JWK<textarea className="input mono" rows={3} value={jwk} onChange={(e) => setJwk(e.target.value)} placeholder='{"kty":"OKP","crv":"Ed25519","x":"..."}' /></label>}
        {error && <p className="notice error">{error}</p>}
        <div className="row"><button className="btn btn-primary" disabled={!name || !org} onClick={register}>Connect</button><button className="btn btn-quiet" onClick={() => setPlatform(null)}>Back</button></div>
      </div>}
      {result && <div className="stack">
        <p className="small">3. Connected: <Chip v="CONNECTED" />. The agent can call ProxyProof but cannot act until its organization grants authority.</p>
        {result.connection_token ? <>
          <p className="small">Run this once in your terminal to add ProxyProof to Claude Code. The token is shown only now; ProxyProof stores only its hash.</p>
          <pre className="code">{cmd}</pre>
          <div className="row"><button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(cmd)}>Copy command</button><button className="btn btn-quiet btn-sm" onClick={() => navigator.clipboard?.writeText(result.connection_token)}>Copy token only</button></div>
          <p className="tiny muted">Other MCP clients: URL {result.mcp_url}, header Authorization: Bearer &lt;token&gt;. Claude.ai, ChatGPT, Grok and Gemini can reach it only once ProxyProof has a public HTTPS URL.</p>
        </> : <p className="small">Your agent signs with its own key: DID <span className="mono">{result.did.slice(0, 28)}…</span>. See docs/architecture/connector-api.md.</p>}
        <p className="small">4. Grant authority. Choose what this agent may do, then approve as its organization.</p>
        <button className="btn btn-primary btn-sm" disabled={!agent} onClick={() => onDelegate(agent)}>Grant authority</button>
      </div>}
    </Modal>
  );
}

function Delegate({ agent, st, onClose, onDone }: any) {
  const seller = agent.side === 'SELLER';
  const prev = agent.delegation?.mandate ?? agent.pending?.mandate;
  const org = st.organizations.find((o: any) => o.id === agent.principal_id);
  const others = st.organizations.filter((o: any) => o.role !== agent.side);
  const [actions, setActions] = useState<string[]>(prev?.actions ?? (seller ? ['quote', 'issue_invoice', 'request_payment'] : ['purchase']));
  const [limit, setLimit] = useState(prev ? String(prev.max_amount_minor / 100) : seller ? '2000' : '500');
  const [review, setReview] = useState(prev?.step_up_above_minor ? String(prev.step_up_above_minor / 100) : '');
  const [cats, setCats] = useState<string[]>(prev?.categories ?? ['coffee']);
  const [cps, setCps] = useState<string[]>(prev?.counterparties ?? []);
  const [dest, setDest] = useState(prev?.destinations?.join(', ') ?? org?.payment_account ?? '');
  const [daysValid, setDays] = useState('30');
  const [stage, setStage] = useState<'edit' | 'approve'>('edit');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const submit = async () => {
    setError(null);
    const max = toMinor(limit), su = review ? toMinor(review) : null;
    if (!max) return setError('Enter a limit.');
    try {
      const r = await api.post(`/api/agents/${agent.id}/delegations`, { mandate: { actions, max_amount_minor: max, currencies: ['USD'], categories: cats, counterparties: cps, destinations: seller ? dest.split(',').map((s: string) => s.trim()).filter(Boolean) : undefined, step_up_above_minor: su }, valid_until: new Date(Date.now() + Math.max(1, Number(daysValid) || 1) * 86_400_000).toISOString() });
      setPendingId(r.id); setStage('approve');
    } catch (e: any) { setError(e.message); }
  };
  const approve = async () => { try { await api.post(`/api/delegations/${pendingId}/approve`); await onDone(); } catch (e: any) { setError(e.message); } };
  return (
    <Modal title={`Authority for ${agent.name}`} onClose={onClose}>
      {stage === 'edit' ? <div className="stack">
        <div className="field">{seller ? 'Seller authority' : 'Buyer authority'}<div className="checks-inline">{(seller ? ['quote', 'issue_invoice', 'request_payment'] : ['purchase', 'research']).map((a) => <label key={a}><input type="checkbox" checked={actions.includes(a)} onChange={() => toggle(actions, setActions, a)} />{a.replace(/_/g, ' ')}</label>)}</div>
          <span className="tiny muted" style={{ fontWeight: 400 }}>{seller ? 'Requesting payment never lets an agent debit a buyer: the buyer still approves on PayPal.' : 'Research only means no purchases.'}</span></div>
        <div className="row" style={{ alignItems: 'end' }}>
          <label className="field" style={{ flex: 1 }}>Limit (USD)<input className="input" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
          {!seller && <label className="field" style={{ flex: 1 }}>Review above (USD, optional)<input className="input" inputMode="decimal" value={review} onChange={(e) => setReview(e.target.value)} /></label>}
          <label className="field" style={{ width: 110 }}>Valid (days)<input className="input" inputMode="numeric" value={daysValid} onChange={(e) => setDays(e.target.value)} /></label>
        </div>
        <div className="field">Categories<div className="checks-inline">{['coffee', 'equipment', 'service'].map((c) => <label key={c}><input type="checkbox" checked={cats.includes(c)} onChange={() => toggle(cats, setCats, c)} />{c}</label>)}</div></div>
        <div className="field">{seller ? 'May bill' : 'May buy from'}<div className="checks-inline">{others.map((p: any) => <label key={p.id}><input type="checkbox" checked={cps.includes(p.did)} onChange={() => toggle(cps, setCps, p.did)} />{p.name}</label>)}</div></div>
        {seller && <label className="field">Payment accounts (comma separated)<input className="input" value={dest} onChange={(e) => setDest(e.target.value)} /></label>}
        {error && <p className="notice error">{error}</p>}
        <button className="btn btn-primary" onClick={submit}>Review delegation</button>
      </div> : <div className="stack">
        <p className="small">This delegation is pending. Approving signs it with <strong>{org?.name}</strong>’s organization key and binds it to this agent’s key. In this demo you act for every organization.</p>
        {error && <p className="notice error">{error}</p>}
        <div className="row"><button className="btn btn-primary" onClick={approve}>Approve as {org?.name}</button><button className="btn btn-quiet" onClick={onDone}>Leave pending</button></div>
      </div>}
    </Modal>
  );
}

function ApiInfo({ st, onClose }: any) {
  const b = `/api/v1/workspaces/${st.workspace.id}`;
  return (
    <Modal title="Agent API and MCP connector" onClose={onClose}>
      <p className="small"><strong>MCP:</strong> <span className="mono">{st.workspace.mcp_url}</span> (Streamable HTTP, spec 2026-07-28 with 2025 fallback) with header <span className="mono">Authorization: Bearer ppc_…</span>. Tools: get_agent_status, list_counterparties, request_authority, submit_offer, review_transaction, accept_transaction, execute_checkout, get_decision_receipt.</p>
      <div className="endpoints">
        <div><code>GET {b}/directory</code> organizations, DIDs, signing audience</div>
        <div><code>POST {b}/agents</code> register an agent’s own public key (Connected, not authorized)</div>
        <div><code>POST {b}/agents/credential</code> collect the delegation the organization signed</div>
        <div><code>POST {b}/challenges</code> single-use nonce</div>
        <div><code>POST {b}/offers</code> seller agent: signed offer + delegation + terms</div>
        <div><code>POST {b}/transactions/:id/accept</code> buyer agent: signed acceptance + mandate; returns a permit on ALLOW</div>
        <div><code>POST {b}/transactions/:id/execute</code> spend a permit on the protected checkout</div>
        <div><code>GET {b}/transactions/:id/proof</code> signed bilateral evidence bundle</div>
        <div><code>GET /.well-known/jwks.json</code> key for receipts, permits and bundles</div>
      </div>
      <p className="tiny muted">Full reference: docs/architecture/connector-api.md.</p>
    </Modal>
  );
}

function Audit({ onClose }: { onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { api.get('/api/audit').then(setD).catch(() => setD({ error: true })); }, []);
  return (
    <Modal title="Audit log" onClose={onClose}>
      {!d ? <p className="small muted">Loading…</p> : d.error ? <p className="notice error">Could not load the audit log.</p> : <>
        <p className="small">Hash-chained per workspace. Chain <strong>{d.chain.ok ? 'intact' : `broken at event ${d.chain.brokenAtSeq}`}</strong>, {d.chain.events} events. A hash chain detects edits; it is not by itself legal non-repudiation.</p>
        <div className="endpoints">{d.events.slice(0, 80).map((e: any) => <div key={e.seq}><span className="mono tiny muted">#{e.seq}</span> <strong>{e.event_type.toLowerCase().replace(/_/g, ' ')}</strong> <span className="tiny muted">{when(e.created_at)}{e.payload?.decision ? ` · ${e.payload.decision}` : ''}{e.payload?.code ? ` · ${e.payload.code}` : ''}</span></div>)}</div>
      </>}
    </Modal>
  );
}
