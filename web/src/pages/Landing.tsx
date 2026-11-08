import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Monogram } from '../Monogram';
import { useMe } from '../main';
import { Modal } from '../ui';

const IC3 = 'https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf';
const AFP = 'https://www.financialprofessionals.org/about/learn-more/press-releases/Details/over-75-percent-of-us-firms-experienced-payments-fraud-in-2025-while-ai-adoption-for-fraud-mitigation-lags';
// Every figure is quoted from the named source; the average is calculated from two figures in the same report.
const STATS = [
  { v: '$3.05B', t: 'lost to business email compromise in 2025, up from $2.77B.', src: 'FBI IC3 2025 report', href: IC3 },
  { v: '76%', t: 'of US organizations faced attempted or actual payments fraud in 2025.', src: 'AFP 2026 survey', href: AFP },
  { v: '$123K', t: 'average loss per business email compromise complaint.', src: 'Calculated: $3.05B ÷ 24,768 FBI complaints', href: IC3 },
  { v: '$893M', t: 'lost to scams involving AI in 2025.', src: 'FBI IC3 2025 report', href: IC3 },
];

const DECISIONS = [
  { k: 'allow', name: 'Allowed', means: 'Verified payee, matching bank or PayPal details, within the requester’s authority.', next: 'Can be released to PayPal.', eg: 'A known supplier’s regular invoice.' },
  { k: 'review', name: 'Under review', means: 'Looks legitimate but needs a person’s sign-off.', next: 'Waits for an approver.', eg: 'An amount above your approval limit.' },
  { k: 'hold', name: 'Held', means: 'Something important cannot be verified yet.', next: 'Blocked until it is checked independently.', eg: 'An invoice with new payment details.' },
  { k: 'deny', name: 'Denied', means: 'Breaks one of your rules.', next: 'Cannot be paid.', eg: 'An agent asking for more than its limit.' },
];
const AGENT_STEPS: [string, string][] = [
  ['Signed request', 'Each agent has its own key and a written scope: which vendors, which categories, how much.'],
  ['Same checks as a person', 'The request is verified against your records and your rules, then gets one of the four answers.'],
  ['Only the gate pays', 'Agents never see PayPal credentials. Only an allowed payment can pass the gate, and only once.'],
];

const STEPS = [
  ['Request received', 'From a person or an AI agent'],
  ['Evidence checked', 'Registry, history, sender, document'],
  ['Policy decides', 'Deterministic rules, no model vote'],
  ['Gate', 'Re-checks live state, claims once'],
  ['PayPal sandbox', 'Provider confirms the result'],
];

export function Landing() {
  const nav = useNavigate();
  const { refresh, me } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [auth, setAuth] = useState<'login' | 'signup' | null>(null);
  const start = async () => {
    setBusy(true); setError(null);
    try { await api.post('/api/demo/start'); await refresh(); nav('/app'); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="landing">
      <header className="landing-top"><div className="landing-top-inner">
        <span className="brand"><Monogram size={30} />PayeeProof</span><span style={{ flex: 1 }} />
        {me.user ? <button className="btn btn-sm btn-primary" onClick={() => nav('/app')}>My Dashboard</button> : <button className="btn btn-sm btn-quiet" onClick={() => setAuth('login')}>Sign in</button>}
      </div></header>
      <main id="main">
        <section className="first" aria-labelledby="alarm-h">
          <h1 id="alarm-h" className="alarm-title">Businesses lost $3 billion to fake payment emails last year.</h1>
          <div className="alarm-grid">
            {STATS.map((x) => (
              <div key={x.v} className="alarm-cell">
                <div className="alarm-v">{x.v}</div>
                <p>{x.t}</p>
                <a className="alarm-src" href={x.href} target="_blank" rel="noreferrer">{x.src}</a>
              </div>
            ))}
          </div>
          <div className="relief">
            <Monogram size={64} animate bg="#e8f5ef" title="PayeeProof monogram" />
            <div>
              <h2>Don’t worry, you’re protected with PayeeProof.</h2>
              <p>The secured AI payment harness you can rely on. Every payment, from a person or an AI agent, is verified and gated before it can reach PayPal.</p>
            </div>
            <div className="relief-act">
              <button className="btn btn-primary btn-lg" onClick={me.user ? () => nav('/app') : start} disabled={busy}>{busy ? 'Preparing…' : 'My Dashboard'}</button>
              {!me.user && <span className="tiny muted">Demo workspace, PayPal sandbox. <button className="linkish" onClick={() => setAuth('signup')}>Create your own</button></span>}
            </div>
            {error && <div className="notice error" style={{ gridColumn: '1 / -1' }} role="alert">{error}</div>}
          </div>
        </section>

        <section className="explain" aria-labelledby="states-h">
          <h2 id="states-h">Every payment gets one clear answer</h2>
          <p className="explain-sub">PayeeProof checks who is asking, who would receive the money and whether the details match your records. Then it gives one of four answers, and shows why.</p>
          <div className="states">
            {DECISIONS.map((d) => (
              <div key={d.k} className={`state s-${d.k}`}>
                <div className="state-name">{d.name}</div>
                <p>{d.means}</p>
                <p className="state-next">{d.next}</p>
                <p className="state-eg">{d.eg}</p>
              </div>
            ))}
          </div>
          <p className="explain-note">Allowed is not the same as paid. A payment is marked completed only after PayPal confirms it.</p>
        </section>

        <section className="explain" aria-labelledby="agents-h">
          <h2 id="agents-h">How AI agents work with PayeeProof</h2>
          <p className="explain-sub">Agents can ask for a payment. They can never approve or send one themselves.</p>
          <ol className="agent-steps">
            {AGENT_STEPS.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}
          </ol>
        </section>

        <section className="gate-demo">
          <div>
            <h2 className="h1">One gate. No way around it.</h2>
            <p className="lead" style={{ marginTop: 16 }}>Every payment, from a person or an agent, passes through the same server-side gate. It checks the signed decision, runs the policy again on live data, and claims the payment once. Only the gate holds PayPal credentials. AI models never see them.</p>
          </div>
          <div className="verdict HOLD" aria-label="Example of a held payment">
            <div className="word">Held</div>
            <p className="why">The invoice asks for payment to a PayPal account Northwind has never used.</p>
            <div className="path"><ol>{STEPS.map(([t, s], i) => <li key={t} className={i < 3 ? 'done' : i === 3 ? 'blocked' : 'unreached'}><span className="dot" />{t}<span className="sub">{i === 3 ? 'Stopped here. The executor was not called.' : s}</span></li>)}</ol></div>
          </div>
        </section>

        <section style={{ marginTop: 72 }}>
          <h2 className="h2">Try to break it</h2>
          <p className="lead" style={{ marginTop: 12 }}>Security Testing runs 29 attacks and legitimate payments through the same pipeline as your own uploads: swapped destinations, lookalike domains, duplicates, prompt injection, forged agents, replays and bypass attempts. You can also upload your own files.</p>
          <p className="disclaimer" style={{ marginTop: 28 }}>PayeeProof is an independent hackathon project. It is not affiliated with, endorsed by or certified by PayPal. Payments use the PayPal sandbox and move no real money. No system detects every fraud; PayeeProof fails closed when it cannot verify something critical, and shows its evidence for every decision.</p>
        </section>
      </main>
      {auth && <AuthModal mode={auth} setMode={setAuth} />}
    </div>
  );
}

function AuthModal({ mode, setMode }: { mode: 'login' | 'signup'; setMode: (m: 'login' | 'signup' | null) => void }) {
  const nav = useNavigate();
  const { refresh } = useMe();
  const [f, setF] = useState({ email: '', password: '', name: '', workspaceName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.post(mode === 'login' ? '/api/auth/login' : '/api/auth/signup', f); await refresh(); nav('/app'); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={mode === 'login' ? 'Sign in' : 'Create a workspace'} onClose={() => setMode(null)}>
      <form className="stack-sm" onSubmit={submit} style={{ marginTop: 12 }}>
        {mode === 'signup' && <><label className="field">Your name<input className="input" required value={f.name} onChange={set('name')} autoComplete="name" /></label>
          <label className="field">Business name<input className="input" required value={f.workspaceName} onChange={set('workspaceName')} /></label></>}
        <label className="field">Email<input className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
        <label className="field">Password<span className="hint">{mode === 'signup' ? 'At least 10 characters.' : ''}</span><input className="input" type="password" required minLength={mode === 'signup' ? 10 : 1} value={f.password} onChange={set('password')} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} /></label>
        {error && <div className="notice error" role="alert">{error}</div>}
        <div className="row" style={{ marginTop: 6 }}>
          <button className="btn btn-primary" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create workspace'}</button>
          <button type="button" className="btn btn-quiet" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create a workspace instead' : 'I already have an account'}</button>
        </div>
      </form>
    </Modal>
  );
}
