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
  { v: '$3.05B', t: 'lost to business email compromise in 2025, up from $2.77B in 2024.', src: 'FBI IC3 2025 Internet Crime Report', href: IC3 },
  { v: '76%', t: 'of US organizations faced attempted or actual payments fraud in 2025.', src: 'AFP 2026 Payments Fraud and Control Survey', href: AFP },
  { v: '$123K', t: 'average loss per business email compromise complaint ($3.05B across 24,768 complaints).', src: 'Calculated from FBI IC3 2025 figures', href: IC3 },
  { v: '$893M', t: 'lost to scams involving AI, reported to the FBI in 2025.', src: 'FBI IC3 2025 Internet Crime Report', href: IC3 },
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
        <section className="alarm" aria-labelledby="alarm-h">
          <h1 id="alarm-h" className="display">Businesses lost $3 billion to fake payment emails last year.</h1>
          <p className="lead">A changed bank account in an invoice. A “CEO” asking for an urgent wire. Now AI agents that pay whatever they are told. Every number below comes from the FBI or the Association for Financial Professionals.</p>
          <div className="alarm-grid">
            {STATS.map((x) => (
              <div key={x.v} className="alarm-cell">
                <div className="alarm-v">{x.v}</div>
                <p>{x.t}</p>
                <a className="alarm-src" href={x.href} target="_blank" rel="noreferrer">{x.src}</a>
              </div>
            ))}
          </div>
        </section>

        <section className="relief" aria-labelledby="relief-h">
          <Monogram size={120} animate bg="#e8f5ef" title="PayeeProof monogram" />
          <div>
            <h2 id="relief-h" className="h1">Don’t worry, you’re protected with PayeeProof.</h2>
            <p className="lead">The secured AI payment harness you can rely on. Every payment, from a person or an AI agent, is verified, explained and gated before it can reach PayPal.</p>
            <div className="row">
              <button className="btn btn-primary btn-lg" onClick={me.user ? () => nav('/app') : start} disabled={busy}>{busy ? 'Preparing your dashboard…' : 'My Dashboard'}</button>
            </div>
            {error && <div className="notice error" style={{ marginTop: 16 }} role="alert">{error}</div>}
            {!me.user && <p className="muted small" style={{ marginTop: 14 }}>Opens a demo workspace with fictional vendors, an AI agent and ten sample requests, each decided live by the policy engine. Payments use the PayPal sandbox. <button className="linkish" onClick={() => setAuth('signup')}>Create your own workspace</button></p>}
          </div>
        </section>

        <section className="questions" aria-label="What every payment must answer">
          {[['Intent', 'What did the business or person actually authorize?'], ['Identity', 'Who is asking, who sent the invoice, and who would receive the money?'], ['Evidence', 'What do your own records and independent sources say?'], ['Enforcement', 'Does deterministic policy permit this exact transaction?']].map(([h, p]) => (
            <div key={h}><h3>{h}</h3><p className="muted">{p}</p></div>
          ))}
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
