import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Bot, BotOff, Check, EyeOff, Landmark, Minus, Plus, Repeat2, RotateCw, VenetianMask } from 'lucide-react';
import { api } from '../api';
import { Monogram, Wordmark } from '../Monogram';
import { useMe } from '../main';
import { usePrefersReducedMotion } from '../ui';
import '../landing.css';
import { Hero } from './Hero';

/*
 * Landing page. Light paper, black ink, thin outlined cards with a hard drop shadow, one accent per card.
 * The "live check" card replays one illustrative payment; every check it names is one the backend performs
 * (server/src/trust/party.ts, bilateral.ts). The scenario lab is where real agents run real checks.
 */

const TIMELINE: [number, number][] = [[400, 1], [1300, 2], [2100, 3], [2900, 4], [3700, 5], [4500, 6], [5400, 7]];
const DONE = 7;
const STEPS = [
  { at: 1, label: 'Buyer’s agent signs', detail: 'Northwind’s agent signs the $240 order with its own key.' },
  { at: 2, label: 'Its mandate is real', detail: 'Northwind Hotels signed it: may buy coffee, up to $500.' },
  { at: 3, label: 'Seller’s agent signs', detail: 'Harbor & Pine’s agent signs the same terms.' },
  { at: 4, label: 'Its delegation is real', detail: 'Harbor & Pine signed it: may invoice, paid only to its enrolled account.' },
  { at: 5, label: 'Same terms, both sides', detail: 'One terms hash. Change a cent and it no longer matches.' },
  { at: 6, label: 'Single-use permit', detail: 'Allowed. One permit, five minutes, these exact terms.' },
  { at: 7, label: 'PayPal checkout opens', detail: 'Only now can money move, and the buyer still approves on PayPal.' },
];

function useReplay(reduce: boolean) {
  const [step, setStep] = useState(reduce ? DONE : 0);
  const [run, setRun] = useState(0);
  useEffect(() => {
    if (reduce && run === 0) { setStep(DONE); return; }
    setStep(0);
    const ts = TIMELINE.map(([ms, s]) => window.setTimeout(() => setStep(s), ms));
    return () => ts.forEach(clearTimeout);
  }, [run, reduce]);
  return { step, replay: () => setRun((r) => r + 1) };
}

/** One payment, checked on both sides, in a single card. */
function LiveCheck() {
  const reduce = usePrefersReducedMotion();
  const { step, replay } = useReplay(reduce);
  const done = step >= DONE;
  const buyerOk = step >= 2, sellerOk = step >= 4;
  return (
    <section className="pp-card pp-live" aria-labelledby="live-h">
      <div className="pp-card-h">
        <h2 id="live-h">Live check</h2>
        <span className="pp-ver">Invoice HP-1042 · $240.00</span>
      </div>
      <hr />
      <div className="pp-live-body">
        <div className="pp-parties" aria-hidden="true">
          <div className={`pp-party${buyerOk ? ' ok' : step >= 1 ? ' on' : ''}`}><span className="pp-bot"><Bot /></span><strong>Northwind’s agent</strong><small>pays</small>{buyerOk && <Check className="pp-ok" />}</div>
          <div className={`pp-wire${done ? ' ok' : ''}`}><span className={`pp-coin${done ? ' paid' : ''}`}>$240</span></div>
          <div className={`pp-party${sellerOk ? ' ok' : step >= 3 ? ' on' : ''}`}><span className="pp-bot"><Bot /></span><strong>Harbor & Pine’s agent</strong><small>collects</small>{sellerOk && <Check className="pp-ok" />}</div>
        </div>
        <ol className="pp-steps">
          {STEPS.map((s) => (
            <li key={s.at} className={step >= s.at ? 'done' : step === s.at - 1 ? 'next' : ''}>
              <span className="mark">{step >= s.at ? <Check /> : null}</span>
              <span><strong>{s.label}</strong><small>{s.detail}</small></span>
            </li>
          ))}
        </ol>
      </div>
      <div className="pp-live-foot">
        <p aria-live="polite">{done ? 'Both sides proven. Checkout opened.' : step === 0 ? 'Two agents, one payment. Nothing proven yet.' : 'Checking both sides…'}</p>
        <button className="pp-link-btn" onClick={replay}><RotateCw aria-hidden="true" />Replay</button>
      </div>
    </section>
  );
}

const RISKS = [
  { icon: Landmark, title: 'Bank details changed', text: 'The invoice comes from the supplier’s real agent but asks to be paid into an account the business never enrolled. ProxyProof holds it. Business email compromise cost US firms $2.77B in 2024.' },
  { icon: VenetianMask, title: 'Forged authority', text: 'An agent shows a mandate in Northwind’s name that Northwind never signed. Authority is a signature from the organization’s key, not a convincing document.' },
  { icon: EyeOff, title: 'Hidden prompt injection', text: 'Text on a web page tells the buyer’s agent to add a $395 grinder. The agent obeys, but equipment is outside its mandate, so the payment is held.' },
  { icon: BotOff, title: 'Agent revoked mid-payment', text: 'Northwind switches its agent off while a payment is queued. Authority is checked again at the moment of payment, so the permit is refused.' },
  { icon: Repeat2, title: 'Same payment sent twice', text: 'A retry reuses the permit. Each permit pays once, so the second attempt never reaches PayPal.' },
];

function Risks() {
  const [open, setOpen] = useState(0);
  return (
    <div className="pp-risks">
      {RISKS.map((r, i) => {
        const on = open === i;
        const I = r.icon;
        return (
          <section key={r.title} className={`pp-card pp-risk${on ? ' open' : ''}`}>
            <button className="pp-risk-h" aria-expanded={on} onClick={() => setOpen(on ? -1 : i)}>
              <span className="t"><I aria-hidden="true" />{r.title}</span>
              <span className="pp-round" aria-hidden="true">{on ? <Minus /> : <Plus />}</span>
            </button>
            {on && <p>{r.text}</p>}
          </section>
        );
      })}
    </div>
  );
}

const HOW = [
  { n: '1', title: 'Businesses sign what their agents may do', text: 'Each organization signs a mandate for its own agent: what it may buy or invoice, how much, with whom, and where money may go.' },
  { n: '2', title: 'Both agents sign the same terms', text: 'The seller’s agent signs the quote or invoice. The buyer’s agent signs the identical terms hash. Each with its own key.' },
  { n: '3', title: 'ProxyProof checks both sides', text: 'Identity, enrollment, signed authority, live revocation, limits, counterparty and payout account. Allow, hold, review or deny, with the reason.' },
  { n: '4', title: 'Only then, PayPal', text: 'Allow issues a single-use permit for those exact terms. It opens a PayPal sandbox checkout, re-checked live, and paid only when PayPal confirms.' },
];

export function Landing() {
  const nav = useNavigate();
  const { me, refresh } = useMe();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    if (me.user) return nav('/app');
    setBusy(true); setError(null);
    try { await api.post('/api/demo/start'); await refresh(); nav('/app'); } catch (e: any) { setError(e.message); setBusy(false); }
  };

  return (
    <div className="pp">
      <header className="pp-nav">
        <Link to="/" className="pp-brand" aria-label="ProxyProof home"><Wordmark size={30} ring /></Link>
        <nav aria-label="Main">
          <a href="#how">How it works</a>
          <a href="#risks">What it catches</a>
          <Link to="/architecture">Architecture</Link>
          <a href="https://github.com/artisolv/proxyproof" target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <button className="pp-btn outline sm" onClick={open} disabled={busy}>{me.user ? 'Open the lab' : 'Try the demo'}</button>
      </header>

      <Hero onDemo={open} busy={busy} />

      <main>
        {error && <p className="pp-error" role="alert">{error}</p>}
        <div className="pp-grid two">
          <section className="pp-card pp-accent" aria-labelledby="pay-h">
            <div className="pp-card-h"><h2 id="pay-h">Pay a supplier’s agent</h2><span className="pp-round dark" aria-hidden="true"><ArrowUpRight /></span></div>
            <p>Your agent pays an invoice. ProxyProof confirms the seller’s agent may collect, into the account the business enrolled.</p>
          </section>
          <section className="pp-card pp-plain" aria-labelledby="collect-h">
            <div className="pp-card-h"><h2 id="collect-h">Get paid by a buyer’s agent</h2><span className="pp-round" aria-hidden="true"><ArrowUpRight /></span></div>
            <p>Before you ship, ProxyProof confirms the buyer’s agent may spend this amount, with you, for this order.</p>
          </section>
        </div>

        <section className="pp-section" id="risks" aria-labelledby="risks-h">
          <div className="pp-section-h">
            <h2 id="risks-h">What goes wrong without it</h2>
            <p>Five real patterns from business payments, each run live in the demo. Every outcome comes from ProxyProof’s actual checks.</p>
          </div>
          <Risks />
        </section>

        <section className="pp-section" id="how" aria-labelledby="how-h">
          <div className="pp-section-h"><h2 id="how-h">How it works</h2><p>Four steps, the same for every payment.</p></div>
          <ol className="pp-how">
            {HOW.map((h) => (
              <li key={h.n} className="pp-card">
                <span className="pp-n">{h.n}</span>
                <h3>{h.title}</h3>
                <p>{h.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="pp-section pp-facts" aria-label="Facts">
          <div className="pp-card"><strong>Any agent</strong><p>Claude, ChatGPT, Gemini, Grok or your own framework, over MCP or a REST API.</p></div>
          <div className="pp-card"><strong>Real checks</strong><p>Ed25519 signatures, signed delegations, live revocation, single-use permits. 64 automated tests.</p></div>
          <div className="pp-card"><strong>PayPal sandbox</strong><p>Real Orders v2 checkouts. Paid only when PayPal confirms the capture.</p></div>
          <div className="pp-card"><strong>Open source</strong><p>MIT licensed. <a href="https://github.com/artisolv/proxyproof" target="_blank" rel="noreferrer">Read the code</a>.</p></div>
        </section>

        <section className="pp-card pp-final" aria-labelledby="final-h">
          <div><h2 id="final-h">Try it with real agents</h2><p>Pick a payment, pick what goes wrong, and watch ProxyProof decide.</p></div>
          <button className="pp-btn light" onClick={open} disabled={busy}>Open the live demo</button>
        </section>
      </main>

      <footer className="pp-foot">
        <span className="pp-foot-brand"><Monogram size={22} title="" />ProxyProof</span>
        <p>An independent hackathon project, not affiliated with or endorsed by PayPal, Anthropic, OpenAI, xAI, Google, Visa or Mastercard. Payments use the PayPal sandbox and move no real money. ProxyProof enforces only the actions routed through it; no system can stop every fraud.</p>
      </footer>
    </div>
  );
}
