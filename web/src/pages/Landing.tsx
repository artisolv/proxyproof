import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Monogram } from '../Monogram';
import { useMe } from '../main';
import { PERSPECTIVE, Question, usePrefersReducedMotion, type Action } from '../ui';

/** One loop of the illustration. Which side is checked first follows the question being asked. */
const CYCLE: { action: Action; pass: boolean; stopAt: 'buyer' | 'seller' | null; reason: string }[] = [
  { action: 'MAKE', pass: true, stopAt: null, reason: 'Both authorities verified, same terms signed. Checkout opens.' },
  { action: 'COLLECT', pass: false, stopAt: 'seller', reason: 'Stopped: the seller’s agent may quote, but not invoice.' },
  { action: 'MAKE', pass: false, stopAt: 'buyer', reason: 'Stopped: the buyer revoked its agent’s authority.' },
  { action: 'COLLECT', pass: true, stopAt: null, reason: 'Both authorities verified, same terms signed. Checkout opens.' },
];
const STEP_MS = 5000;

function BilateralViz({ step, phase }: { step: number; phase: number }) {
  const c = CYCLE[step];
  // MAKE: the seller asks about the buyer's agent first. COLLECT: the buyer asks about the seller's agent first.
  const order: ('buyer' | 'seller' | 'terms')[] = c.action === 'MAKE' ? ['buyer', 'seller', 'terms'] : ['seller', 'buyer', 'terms'];
  const lit = Math.max(0, Math.min(3, phase - 1));
  const stopIdx = c.stopAt ? order.indexOf(c.stopAt) : -1;
  const state = (k: 'buyer' | 'seller' | 'terms') => {
    const i = order.indexOf(k);
    if (i >= lit) return 'idle';
    if (stopIdx >= 0 && i === stopIdx) return 'fail';
    if (stopIdx >= 0 && i > stopIdx) return 'idle';
    return 'pass';
  };
  const done = phase >= 5;
  const open = done && c.pass;
  const col = (s: string) => (s === 'pass' ? 'var(--green-line)' : s === 'fail' ? 'var(--red)' : 'var(--line)');
  const box = (x: number, y: number, w: number, h: number, t1: string, t2: string, hi?: string) => (
    <g className="fv-node"><rect x={x} y={y} width={w} height={h} rx="12" style={hi ? { stroke: hi, strokeWidth: 2 } : undefined} /><text x={x + w / 2} y={y + h / 2 - 3} textAnchor="middle">{t1}</text><text className="sub" x={x + w / 2} y={y + h / 2 + 14} textAnchor="middle">{t2}</text></g>
  );
  const checks: ['buyer' | 'seller' | 'terms', string, number][] = [['buyer', 'Buyer agent authority', 124], ['seller', 'Seller agent authority', 160], ['terms', 'Same signed terms', 196]];
  return (
    <svg viewBox="0 0 560 330" role="img" aria-label={`Two agents from different organizations pass through one ProxyProof boundary. ${c.reason}`}>
      {box(8, 14, 150, 52, 'Buyer organization', 'signs a purchase mandate')}
      {box(402, 14, 150, 52, 'Seller organization', 'signs a business delegation')}
      {box(8, 98, 150, 64, 'Buyer’s AI agent', 'any platform', c.action === 'MAKE' && phase >= 1 ? 'var(--green-line)' : undefined)}
      {box(402, 98, 150, 64, 'Seller’s AI agent', 'any platform', c.action === 'COLLECT' && phase >= 1 ? 'var(--green-line)' : undefined)}
      <line className="fv-wire" x1="83" y1="66" x2="83" y2="98" /><line className="fv-wire" x1="477" y1="66" x2="477" y2="98" />
      <line className={`fv-wire ${state('buyer') === 'pass' ? 'fv-pass' : ''}`} x1="158" y1="130" x2="200" y2="130" style={state('buyer') === 'fail' ? { stroke: 'var(--red)' } : undefined} />
      <line className={`fv-wire ${state('seller') === 'pass' ? 'fv-pass' : ''}`} x1="360" y1="130" x2="402" y2="130" style={state('seller') === 'fail' ? { stroke: 'var(--red)' } : undefined} />
      <rect className="fv-layer" x="200" y="92" width="160" height="128" rx="14" />
      <text x="280" y="86" textAnchor="middle" style={{ font: '700 12px var(--font)', fill: 'var(--green-deep)' }}>ProxyProof boundary</text>
      {checks.map(([k, label, y]) => (
        <g key={k}>
          <circle cx="218" cy={y} r="7" style={{ fill: state(k) === 'idle' ? '#fff' : col(state(k)), stroke: col(state(k)), strokeWidth: 2, transition: 'fill .2s, stroke .2s' }} />
          <text x="232" y={y + 4} style={{ font: '600 10.5px var(--font)', fill: state(k) === 'fail' ? 'var(--red)' : 'var(--ink-2)' }}>{label}</text>
        </g>
      ))}
      <line className={`fv-wire ${open ? 'fv-pass' : ''}`} x1="280" y1="220" x2="280" y2="250" />
      {box(190, 250, 180, 52, 'PayPal sandbox checkout', open ? 'buyer approves on PayPal' : 'not reached', open ? 'var(--green-line)' : undefined)}
      <text x="280" y="324" textAnchor="middle" style={{ font: '600 12px var(--font)', fill: !c.pass ? 'var(--red)' : 'var(--green-deep)', opacity: done ? 1 : 0, transition: 'opacity .3s' }}>{c.reason}</text>
    </svg>
  );
}

export function Landing() {
  const nav = useNavigate();
  const { me, refresh } = useMe();
  const reduce = usePrefersReducedMotion();
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState(reduce ? 5 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (reduce) { setPhase(5); return; }
    setPhase(0);
    const timers = [300, 1000, 1500, 2000, 2500].map((ms, i) => window.setTimeout(() => setPhase(i + 1), ms));
    timers.push(window.setTimeout(() => setStep((s) => (s + 1) % CYCLE.length), STEP_MS));
    return () => timers.forEach(clearTimeout);
  }, [step, reduce]);

  const open = async () => {
    if (me.user) return nav('/app');
    setBusy(true); setError(null);
    try { await api.post('/api/demo/start'); await refresh(); nav('/app'); } catch (e: any) { setError(e.message); setBusy(false); }
  };
  const action = CYCLE[step].action;

  return (
    <div className="landing">
      <header className="top"><div className="top-inner">
        <span className="brand"><Monogram size={30} />ProxyProof</span><span className="spacer" />
        <Link className="btn btn-sm btn-quiet" to="/architecture">Architecture</Link>
        <button className="btn btn-sm btn-secondary" onClick={open} disabled={busy}>{me.user ? 'Open dashboard' : 'Explore Live Demo'}</button>
      </div></header>
      <main id="main">
        <section className="hero">
          <div>
            <Question action={action} />
            <div className="persp-line">
              <span className="persp"><i />{reduce ? 'Seller and buyer perspectives' : PERSPECTIVE[action].label}</span>
              <p>{reduce ? `${PERSPECTIVE.MAKE.text} ${PERSPECTIVE.COLLECT.text}` : PERSPECTIVE[action].text}</p>
            </div>
            <p className="lead">Verify both sides before AI agents transact.</p>
            <div className="row cta">
              <button className="btn btn-primary btn-lg" onClick={open} disabled={busy}>{busy ? 'Preparing the demo…' : 'Explore Live Demo'}</button>
              <Link className="btn btn-secondary btn-lg" to="/architecture">Explore the Architecture</Link>
            </div>
            {error && <p className="notice error" style={{ marginTop: 12 }} role="alert">{error}</p>}
          </div>
          <figure className="flowviz grid-bg" style={{ margin: 0 }}>
            <BilateralViz step={reduce ? 0 : step} phase={phase} />
            <figcaption>Illustration of the flow. The live demo runs real agents through the real checks.</figcaption>
          </figure>
        </section>

        <section className="sec" aria-labelledby="problem-h">
          <h2 id="problem-h">Two agents, two organizations, one payment</h2>
          <p className="sub">When a buyer’s AI agent buys from a seller’s AI agent, each side has a question it cannot answer alone. A buyer’s mandate does not prove the seller’s agent speaks for the business. A seller’s invoice does not prove the buyer’s agent may commit the buyer. And neither proves both agents are agreeing to the same terms. ProxyProof checks each side’s authority independently, matches both to one transaction, and only then lets a protected payment start.</p>
        </section>

        <section className="sec" aria-labelledby="two-h">
          <h2 id="two-h">One question, asked from both sides</h2>
          <div className="two">
            <div className="side-card">
              <div className="who">SELLER PERSPECTIVE</div>
              <h3>Is this AI agent authorized to make payment?</h3>
              <ul><li>The buyer organization signed a mandate for this exact agent key</li><li>Purchase permission, limit, categories, approved sellers</li><li>Not expired, not revoked, not replayed</li><li>It signed the same terms the seller offered</li></ul>
            </div>
            <div className="side-card">
              <div className="who">BUYER PERSPECTIVE</div>
              <h3>Is this AI agent authorized to collect payment?</h3>
              <ul><li>The seller business signed a delegation for this exact agent key</li><li>Permission to quote, invoice and request payment, within limits</li><li>Payment only to the account the business enrolled</li><li>It signed the same terms the buyer authorized</li></ul>
            </div>
          </div>
        </section>

        <section className="sec" aria-labelledby="how-h">
          <h2 id="how-h">How it works</h2>
          <ol className="steps">
            <li><span className="n">1</span><strong>Organizations delegate</strong>Each organization connects its agent and signs what it may do. Connected is not authorized.</li>
            <li><span className="n">2</span><strong>Both agents sign</strong>The seller’s agent signs the offer; the buyer’s agent signs the same terms hash. Each with its own key.</li>
            <li><span className="n">3</span><strong>ProxyProof decides</strong>Both authority chains, the term match and the policy: Allow, Hold, Review or Deny, with exact reasons.</li>
            <li><span className="n">4</span><strong>Only then, payment</strong>A single-use permit for those exact terms opens a PayPal sandbox checkout. Paid only when PayPal confirms.</li>
          </ol>
        </section>

        <section className="sec" aria-labelledby="agents-h">
          <h2 id="agents-h">Bring agents from anywhere</h2>
          <p className="sub">ProxyProof does not build agents. Agents created in Claude, ChatGPT, Grok, Gemini or any framework connect through ProxyProof’s MCP connector or REST API. Tested live today: Claude Code over the MCP connector, and independently written agents over the REST API. Other platforms are documented with their real limits. ProxyProof enforces only the protected actions routed through it; it does not control an agent’s other tools.</p>
        </section>

        <section className="sec" aria-labelledby="std-h">
          <h2 id="std-h">Built on existing standards, not replacing them</h2>
          <p className="sub">AP2, ACP, UCP, Visa Trusted Agent Protocol, Verifiable Intent, AuthZEN and PayPal’s own agent tools each cover part of agentic commerce. ProxyProof composes established building blocks to verify both sides of one transaction. It claims no conformance it has not tested. <Link to="/architecture">See what exists and what ProxyProof adds</Link>.</p>
        </section>

        <section className="final">
          <h2>Verify both sides before AI agents transact.</h2>
          <button className="btn btn-lg" onClick={open} disabled={busy}>Explore Live Demo</button>
        </section>
        <p className="disclaimer">ProxyProof is an independent hackathon project, not affiliated with or endorsed by PayPal, Anthropic, OpenAI, xAI, Google, Visa or Mastercard. Product names are used only to describe compatibility. Payments use the PayPal sandbox and move no real money. No system can promise to stop every fraud.</p>
      </main>
    </div>
  );
}
