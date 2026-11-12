import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Monogram, Wordmark } from '../Monogram';
import { useMe } from '../main';
import { Question, usePrefersReducedMotion, type Action } from '../ui';
import '../landing.css';

/*
 * The landing page is one campaign told in two worlds: "Claimed" (an agent's word) and "Proven" (what
 * ProxyProof checks). The hero plays one illustrative transaction from the first world into the second.
 * Every check it shows is one the backend really performs (see server/src/trust/party.ts and bilateral.ts);
 * the names and amounts come from the demo workspace. Northwind's agent may buy up to $500, and anything above
 * $250 needs a person's review, so the story uses $240 to show the straight path.
 */

// ---------- Hero timeline ----------

/** [time in ms, step]. Steps are cumulative: everything at or below the current step has happened. */
const TIMELINE: [number, number][] = [
  [500, 1], [1100, 2], [2300, 3], [2900, 4], [3600, 5], [4100, 6], [5300, 7], [5800, 8], [6600, 9], [7300, 10], [7900, 11], [9300, 12], [10000, 13],
];
const DONE = 13;
const CAPTION: Record<number, string> = {
  0: 'Two agents, one $240 payment. Nothing proven yet.',
  1: 'Northwind’s agent wants to pay $240. The other agent says it collects for Harbor & Pine.',
  2: 'Northwind’s agent wants to pay $240. The other agent says it collects for Harbor & Pine.',
  3: 'ProxyProof holds the payment at the checkpoint. Who is really on each side?',
  4: 'Identity: each request is signed with the agent’s own key, and the signature verifies.',
  5: 'Northwind Hotels signed this exact agent’s mandate: may purchase, up to $500. $240 is within it.',
  6: 'The paying side is proven. Now the receiving agent must prove who it collects for.',
  7: 'Harbor & Pine’s agent signs the very same terms. Any change would void them.',
  8: 'Harbor & Pine Roasters signed this exact agent’s delegation: may invoice, up to $2,000.',
  9: 'Both signed the same terms. Payout only to the account Harbor & Pine enrolled.',
  10: 'Decision: Allow. Nothing revoked or expired. One single-use permit, five minutes, these exact terms.',
  11: 'The permit opens a PayPal sandbox checkout. The buyer approves on PayPal.',
  12: 'PayPal confirms the capture. Only now does it count as paid.',
  13: 'Payer proven. Recipient proven. Same terms, right account. $240 paid.',
};
/** Only these steps are announced to screen readers, so the story is told without a flood of updates. */
const ANNOUNCE = new Set([3, 6, 8, 10, 13]);

const CHECKS: { at: number; title: string; detail: string }[] = [
  { at: 4, title: 'Identity', detail: 'Each request signed with the agent’s own key' },
  { at: 5, title: 'Payer’s authority', detail: 'Northwind’s mandate: may purchase, up to $500' },
  { at: 8, title: 'Recipient’s authority', detail: 'Harbor & Pine’s delegation: may invoice, up to $2,000' },
  { at: 9, title: 'Same terms, right account', detail: 'One terms hash, the enrolled payout account' },
  { at: 10, title: 'Decision', detail: 'Allow, with one single-use permit' },
];

function useTimeline(reduce: boolean, stage: React.RefObject<HTMLElement | null>) {
  const [step, setStep] = useState(reduce ? DONE : 0);
  const [run, setRun] = useState(0);
  // The story starts the first time the stage starts to come into view (straight away on a desktop; after a scroll on a phone).
  useEffect(() => {
    if (reduce || !stage.current) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setRun((r) => r || 1); io.disconnect(); } }, { threshold: 0.12 });
    io.observe(stage.current);
    return () => io.disconnect();
  }, [reduce, stage]);
  useEffect(() => {
    // With reduced motion the finished story is shown first; Replay still walks through it, without movement.
    if (run === 0) { setStep(reduce ? DONE : 0); return; }
    setStep(0);
    const timers = TIMELINE.map(([ms, s]) => window.setTimeout(() => setStep(s), ms));
    return () => timers.forEach(clearTimeout);
  }, [run, reduce]);
  return { step, replay: () => setRun((r) => r + 1) };
}

function Tick() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ---------- How payments changed (shown at the top of the hero) ----------

function Glyph({ kind }: { kind: 'person' | 'shop' | 'agent' }) {
  if (kind === 'person') return <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="16" r="8" /><path d="M8 42c2-9 8-14 16-14s14 5 16 14" /></svg>;
  if (kind === 'shop') return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M6 18l4-10h28l4 10" /><path d="M6 18h36v4a6 6 0 0 1-12 0 6 6 0 0 1-12 0 6 6 0 0 1-12 0z" /><path d="M9 26v16h30V26" /><path d="M20 42V32h8v10" /></svg>;
  // Agent: a rounded head with two eyes and an antenna.
  return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M24 7v6" /><circle cx="24" cy="6" r="2" className="dot" /><rect x="8" y="13" width="32" height="26" rx="9" /><circle cx="18" cy="26" r="2.6" className="dot" /><circle cx="30" cy="26" r="2.6" className="dot" /><path d="M4 24v6M44 24v6" /></svg>;
}

const ERAS = [
  { a: 'person', b: 'person', name: 'Person to person', text: 'You could see who you were paying.' },
  { a: 'person', b: 'shop', name: 'Person to business', text: 'Cards, checkouts and logins vouch for each side.' },
  { a: 'agent', b: 'agent', name: 'Agent to agent?', text: 'Software pays software. Who vouches for either side?' },
] as const;

function Hero({ onDemo, busy }: { onDemo: () => void; busy: boolean }) {
  const reduce = usePrefersReducedMotion();
  const stageRef = useRef<HTMLElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  // The logo sits midway between the end of "Claimed." and the start of "Proven.", level with the words, and the
  // diagonal seam is then drawn through its centre.
  const [badge, setBadge] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = wordsRef.current;
    if (!el) return;
    const place = () => {
      const box = el.getBoundingClientRect(); const a = el.querySelector('.claimed .strike')?.getBoundingClientRect(); const b = el.querySelector('.proven .lx-word')?.getBoundingClientRect();
      if (a && b) setBadge({ x: (a.right + b.left) / 2 - box.left, y: (a.top + a.bottom) / 2 - box.top });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    document.fonts?.ready.then(place).catch(() => {});
    return () => ro.disconnect();
  }, []);
  const seam = useSeamThrough(heroRef, '.lx-words .lx-badge', 0.145, badge);
  const { step, replay } = useTimeline(reduce, stageRef);
  const payerOk = step >= 6;
  const recvSigned = step >= 7;
  const recvOk = step >= 8;
  const matched = step >= 9;
  const allowed = step >= 10;
  const paid = step >= 12;
  const unified = step >= DONE;
  const scanning = step >= 3 && step < 10;
  // Where the payment request is: on the first track (to the boundary), or the second (through to the recipient).
  const packetA = step >= 2 && step < 11 ? (step >= 3 ? 'end' : 'go') : 'hide';
  const packetB = step >= 11 ? (step >= 12 ? 'end' : 'go') : 'hide';
  const [announced, setAnnounced] = useState(CAPTION[step]);
  useEffect(() => { if (ANNOUNCE.has(step)) setAnnounced(CAPTION[step]); }, [step]);

  return (
    <section ref={heroRef} style={seam} className={`lx-hero${unified ? ' unified' : ''}`} aria-labelledby="lx-h1">
      <div className="lx-world-proven" aria-hidden="true" />
      <div className="lx-seam" aria-hidden="true" />

      <div className="lx-hero-inner">
        <header className="lx-intro">
          <h1 id="lx-h1">The future of <span className="nw">agentic transactions,</span> <span className="br">made safe by ProxyProof.</span></h1>
          <p>AI agents are starting to buy, sell and pay each other. Nothing proves who each one acts for. ProxyProof proves both sides before any money moves.</p>
        </header>
        <ol className="lx-eras" aria-label="How payments have changed">
          {ERAS.map((e, i) => (
            <li key={e.name} className={i === 2 ? 'now' : ''}>
              <div className="pair" aria-hidden="true"><Glyph kind={e.a} /><span className={`link${i === 2 ? ' open' : ''}`}>{i === 2 ? <b>?</b> : <i><svg viewBox="0 0 16 16"><path d="M4 8.5l2.6 2.6L12 5.5" /></svg></i>}</span><Glyph kind={e.b} /></div>
              <div><h2>{e.name}</h2><p>{e.text}</p></div>
            </li>
          ))}
        </ol>
        <div className="lx-words" ref={wordsRef}>
          <span className="sr-only">Without proof, an agent’s authority is only claimed. With ProxyProof, it is proven.</span>
          <span className="lx-side claimed" aria-hidden="true">
            <span className="lx-world-name">Without proof</span>
            <span className="lx-word"><span className="strike">Claimed.</span></span>
            <span className="lx-side-copy">An agent says it collects for Harbor & Pine. Your agent pays it, and hopes.</span>
          </span>
          <span className="lx-badge" aria-hidden="true" style={badge ? { left: badge.x, top: badge.y } : { visibility: 'hidden' }}><Monogram size={56} title="" /></span>
          <span className="lx-side proven" aria-hidden="true">
            <span className="lx-world-name">With ProxyProof</span>
            <span className="lx-word">Proven.</span>
            <span className="lx-side-copy">Both agents prove who they act for and what they may do, on identical terms. Then money moves.</span>
          </span>
        </div>

        <figure className="lx-stage" ref={stageRef} aria-label="Illustration: one agent-to-agent payment checked by ProxyProof">
          <div className={`lx-cell payer${payerOk ? ' ok' : ''}${unified ? ' uni' : ''}${step >= 1 && !payerOk ? ' active' : ''}`}>
            <div className="lx-cell-h"><span>Paying agent</span><span className={`lx-pill${payerOk ? ' good' : ''}`}>{paid ? 'Paid' : payerOk ? 'Authorized to pay' : 'Unverified'}</span></div>
            <strong className="lx-agent">Northwind Procurement Agent</strong>
            <span className="lx-org">acts for Northwind Hotels</span>
            <dl className={`lx-intent${step >= 1 ? ' show' : ''}`}>
              <div><dt>Pays</dt><dd>$240.00</dd></div>
              <div><dt>To</dt><dd>Harbor & Pine Sales Agent{recvOk ? '' : '?'}</dd></div>
              <div><dt>For</dt><dd>Invoice HP-1042, coffee</dd></div>
              <div className={matched ? 'hash on' : 'hash'}><dt>Terms</dt><dd>9f3c…41e7</dd></div>
            </dl>
          </div>

          <div className={`lx-track a${payerOk ? ' lit' : ''}`} aria-hidden="true">
            <i className="fill" />
            <span className={`lx-packet ${packetA}`}>$240</span>
          </div>

          <div className={`lx-gate${scanning ? ' scanning' : ''}${allowed ? ' allowed' : ''}${unified ? ' uni' : ''}`}>
            <div className="lx-gate-h"><Monogram size={22} ring title="" /><span>ProxyProof</span><span className="lx-gate-state">{allowed ? 'Allow' : step >= 3 ? 'Checking' : 'Waiting'}</span></div>
            <ol className="lx-checks">
              {CHECKS.map((c) => {
                const st = step >= c.at ? 'pass' : step >= 3 && (CHECKS.find((x) => step < x.at)?.at === c.at) ? 'now' : 'wait';
                return (
                  <li key={c.title} className={st}>
                    <span className="mark">{st === 'pass' ? <Tick /> : null}</span>
                    <span><strong>{c.title}</strong><span className="d">{c.detail}</span></span>
                  </li>
                );
              })}
            </ol>
            <i className="scan" aria-hidden="true" />
          </div>

          <div className={`lx-track b${recvOk ? ' lit' : ''}${payerOk && !recvOk ? ' asking' : ''}`} aria-hidden="true">
            <i className="fill" />
            <span className={`lx-packet ${packetB}`}>{paid ? 'Paid' : 'Permit'}</span>
          </div>

          <div className={`lx-cell recv${recvOk ? ' ok' : ''}${unified ? ' uni' : ''}${payerOk && !recvOk ? ' active' : ''}`}>
            <div className="lx-cell-h"><span>Receiving agent</span><span className={`lx-pill${recvOk ? ' good' : ''}`}>{paid ? 'Payment received' : recvOk ? 'Authorized to collect' : recvSigned ? 'Signed, checking' : 'Unverified'}</span></div>
            <strong className="lx-agent">Harbor & Pine Sales Agent</strong>
            <span className="lx-org">{recvOk ? 'acts for Harbor & Pine Roasters' : 'says it acts for Harbor & Pine Roasters'}</span>
            <dl className={`lx-intent${recvSigned ? ' show' : ''}`}>
              <div><dt>Collects</dt><dd>$240.00</dd></div>
              <div><dt>Into</dt><dd>{recvOk ? 'Harbor & Pine’s enrolled account' : 'an account it names'}</dd></div>
              <div><dt>Checkout</dt><dd>{paid ? 'PayPal confirmed capture' : allowed ? 'PayPal sandbox order' : 'not opened'}</dd></div>
              <div className={matched ? 'hash on' : 'hash'}><dt>Terms</dt><dd>9f3c…41e7</dd></div>
            </dl>
          </div>
        </figure>

        <div className="lx-hero-foot">
          <div className="lx-foot-text">
            <p className="lx-caption" aria-hidden="true"><span key={step}>{CAPTION[step]}</span></p>
            <p className="lx-note">An illustration with names from the demo workspace. In the live demo, real agents go through the same checks against the PayPal sandbox.</p>
          </div>
          <p className="sr-only" aria-live="polite">{announced}</p>
          <div className="lx-actions">
            <button className="lx-btn ghost" onClick={replay}>{unified || reduce ? 'Replay the payment' : 'Restart'}</button>
            <button className="lx-btn solid" onClick={onDemo} disabled={busy}>{busy ? 'Preparing the demo…' : 'Explore Live Demo'}</button>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------- B. The trust gap ----------

const PROOFS = ['Organization’s signature', 'Scope and limit', 'Live revocation status', 'Same signed terms'];

function TrustGap() {
  const [proof, setProof] = useState(false);
  const angle = proof ? 0 : -11;
  const rad = (angle * Math.PI) / 180;
  const half = 170;
  // Pans hang from the beam ends and stay upright, so they move with the ends instead of rotating.
  const left = { x: half - half * Math.cos(rad), y: -half * Math.sin(rad) };
  const right = { x: half * Math.cos(rad) - half, y: half * Math.sin(rad) };
  return (
    <section className="lx-gap" aria-labelledby="lx-gap-h">
      <div className="lx-gap-text">
        <h2 id="lx-gap-h" className="lx-display">Agents can already pay. Proof of who they act for hasn’t caught up.</h2>
        <p>Giving an agent a way to pay is solved. Knowing whether the agent asking to be paid really speaks for the business, may send this invoice, and will be paid into the right account is not.</p>
        <button className="lx-btn solid" aria-pressed={proof} onClick={() => setProof((p) => !p)}>{proof ? 'Take the proof away' : 'Add the proof'}</button>
        <p className="lx-gap-state" aria-live="polite">{proof ? 'Balanced: the payment is backed by proof from both organizations.' : 'Out of balance: a payment request, and nothing to show who stands behind it.'}</p>
      </div>
      <svg className="lx-scale" viewBox="0 0 520 400" role="img" aria-label={proof ? 'A balanced scale: a $240 payment request on one side, four kinds of proof on the other.' : 'A tipped scale: a heavy $240 payment request on one side, an empty pan marked with a question mark on the other.'}>
        <path className="post" d="M260 72V350M200 356h120" />
        <g style={{ transform: `rotate(${angle}deg)`, transformOrigin: '260px 72px', transition: 'transform 1.1s var(--ease)' }}>
          <path className="beam" d="M90 72H430" />
        </g>
        <circle className="pivot" cx="260" cy="72" r="9" />
        <g style={{ transform: `translate(${left.x}px, ${left.y}px)`, transition: 'transform 1.1s var(--ease)' }}>
          <path className="string" d="M90 72L40 200M90 72L140 200" />
          <path className="pan" d="M30 200h120a60 22 0 0 1-120 0z" />
          <rect className="req" x="30" y="128" width="120" height="68" rx="10" />
          <text className="req-t" x="90" y="161" textAnchor="middle">$240</text>
          <text className="req-s" x="90" y="182" textAnchor="middle">Payment request</text>
          <text className="label" x="90" y="258" textAnchor="middle">Ability to pay</text>
        </g>
        <g style={{ transform: `translate(${right.x}px, ${right.y}px)`, transition: 'transform 1.1s var(--ease)' }}>
          <path className="string" d="M430 72L380 200M430 72L480 200" />
          <path className="pan" d="M370 200h120a60 22 0 0 1-120 0z" />
          <text className="q" x="430" y="186" textAnchor="middle" style={{ opacity: proof ? 0 : 1 }}>?</text>
          {PROOFS.map((p, i) => (
            <g key={p} className="token" style={{ opacity: proof ? 1 : 0, transform: proof ? 'none' : 'translateY(-60px)', transition: `transform .6s var(--ease) ${0.12 * (3 - i)}s, opacity .3s ease ${0.12 * (3 - i)}s` }}>
              <rect x="358" y={176 - i * 22} width="144" height="19" rx="9.5" />
              <text x="430" y={189.5 - i * 22} textAnchor="middle">{p}</text>
            </g>
          ))}
          <text className="label" x="430" y="258" textAnchor="middle">Proof of who is asking</text>
        </g>
      </svg>
    </section>
  );
}

// ---------- C. Without vs with ----------

const CONTRAST: [string, string][] = [
  ['An agent says it represents Harbor & Pine.', 'Harbor & Pine’s own key signed this agent’s delegation.'],
  ['Its authority may have expired or been revoked.', 'Expiry and revocation are checked live, at every step.'],
  ['It may be allowed to quote, but not to invoice.', 'Action and limit are checked: invoice, up to $2,000.'],
  ['The payout account could have been swapped.', 'Payment goes only to the account the business enrolled.'],
  ['The terms could change after the buyer approved.', 'Both agents sign one terms hash. Any change voids the permit.'],
  ['Nothing stands between the agent and the payment.', 'Checkout opens only with a single-use permit.'],
];

/**
 * Draws a section's diagonal split so the line passes exactly through the centre of an anchor element
 * (the "vs" badge), at a gentle fixed slope. Returns CSS variables for the clip-path of the green layer.
 */
function useSeamThrough(section: React.RefObject<HTMLElement | null>, anchor: string, slope = 0.04, moved?: unknown) {
  const [vars, setVars] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    const place = () => {
      const box = section.current?.getBoundingClientRect(); const a = section.current?.querySelector(anchor)?.getBoundingClientRect();
      if (!box || !a || !box.width || !box.height) return;
      const ax = (a.left + a.width / 2 - box.left) / box.width; const ay = (a.top + a.height / 2 - box.top) / box.height;
      setVars({ '--seam-top': `${((ax + slope * ay) * 100).toFixed(2)}%`, '--seam-bottom': `${((ax - slope * (1 - ay)) * 100).toFixed(2)}%` });
    };
    place();
    const ro = new ResizeObserver(place);
    if (section.current) ro.observe(section.current);
    document.fonts?.ready.then(place).catch(() => {});
    return () => ro.disconnect();
  }, [section, anchor, slope, moved]);
  return vars as React.CSSProperties;
}

function Contrast() {
  const ref = useRef<HTMLElement>(null);
  const seam = useSeamThrough(ref, '.lx-contrast-head .vs');
  return (
    <section ref={ref} style={seam} className="lx-contrast" aria-labelledby="lx-contrast-h">
      <h2 id="lx-contrast-h" className="sr-only">Without ProxyProof, and with ProxyProof</h2>
      <div className="lx-contrast-bg" aria-hidden="true" />
      <div className="lx-contrast-head" aria-hidden="true"><span className="without">Without</span><span className="vs">vs</span><span className="with">With</span></div>
      <ul className="lx-pairs">
        {CONTRAST.map(([a, b]) => (
          <li key={a}>
            <p className="without"><span className="sr-only">Without: </span>{a}</p>
            <p className="with"><span className="sr-only">With ProxyProof: </span>{b}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- D. How it works ----------

const JOURNEY: { title: string; plain: string; tech: string; fails: string[] }[] = [
  { title: 'An agent starts the payment', plain: 'Harbor & Pine’s agent sends an invoice. Northwind’s agent wants to pay it.', tech: 'The seller’s agent posts an offer: a JWS (agent-request+jwt) over the canonical terms hash, answering a single-use challenge with its own key.', fails: ['SIGNATURE_INVALID', 'REPLAY', 'REQUEST_STALE'] },
  { title: 'The recipient is presented', plain: 'Who the agent is, which business it says it speaks for, and where the money would go.', tech: 'A did:key identity, a delegation credential (vc+jwt) signed by the business and bound to the agent’s key through cnf, and the enrolled payout account.', fails: ['AGENT_UNKNOWN', 'DELEGATION_MISSING', 'SELF_DELEGATION'] },
  { title: 'ProxyProof verifies each agent', plain: 'Did that organization really authorize this agent, and is that still true right now?', tech: 'The delegation signature is checked against the organization’s key, then key binding, expiry, and revocation status, read live on every check and never cached.', fails: ['DELEGATION_FORGED', 'KEY_NOT_BOUND', 'DELEGATION_REVOKED', 'STATUS_UNAVAILABLE'] },
  { title: 'Authority is checked', plain: 'May it do this, for this amount, with this counterparty, into this account?', tech: 'Action scope (purchase or issue_invoice), amount limit, approved counterparty and, for the seller, the payout destination.', fails: ['ACTION_NOT_PERMITTED', 'AMOUNT_EXCEEDS_LIMIT', 'COUNTERPARTY_NOT_APPROVED', 'DESTINATION_NOT_AUTHORIZED'] },
  { title: 'Both sides are matched and decided', plain: 'Both agents must agree to exactly the same terms. The answer is Allow, Hold, Review or Deny, with reasons.', tech: 'Both requests carry the same SHA-256 terms hash. A deterministic policy decides. Allow issues a single-use, five-minute permit (execution-permit+jwt) bound to that hash.', fails: ['TERMS_MISMATCH', 'TERMS_MODIFIED', 'REVIEW_REQUIRED'] },
  { title: 'The payment proceeds', plain: 'Only a valid permit opens checkout. The buyer approves on PayPal, and it counts as paid only when PayPal confirms.', tech: 'The executor verifies and atomically claims the permit, re-verifies both sides on live state, then creates a PayPal Orders v2 sandbox order. Capture re-verifies again, and a signed evidence bundle records it all.', fails: ['PERMIT_ALREADY_USED', 'TERMS_CHANGED', 'LIVE_RECHECK_FAILED'] },
];

function Journey() {
  const reduce = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  const [action, setAction] = useState<Action>('COLLECT');
  useEffect(() => {
    if (reduce) return;
    const t = window.setInterval(() => setAction((a) => (a === 'MAKE' ? 'COLLECT' : 'MAKE')), 3800);
    return () => clearInterval(t);
  }, [reduce]);
  const s = JOURNEY[i];
  return (
    <section className="lx-journey" aria-labelledby="lx-journey-h">
      <h2 id="lx-journey-h" className="lx-display">How one payment gets proven</h2>
      <div className="lx-question">
        <Question action={action} as="h3" />
        <p>ProxyProof asks it from both sides. The seller asks it about the buyer’s agent, the buyer asks it about the seller’s, and neither side’s answer is taken on trust.</p>
      </div>
      <div className="lx-rail" role="tablist" aria-label="Steps of one payment">
        {JOURNEY.map((j, n) => (
          <button key={j.title} role="tab" id={`lx-tab-${n}`} aria-selected={n === i} aria-controls="lx-step-panel" className={n < i ? 'past' : ''} onClick={() => setI(n)}>
            <span className="n">{n + 1}</span><span className="t">{j.title}</span>
          </button>
        ))}
      </div>
      <div className="lx-step" id="lx-step-panel" role="tabpanel" aria-labelledby={`lx-tab-${i}`} key={i}>
        <div><h4>In plain terms</h4><p className="plain">{s.plain}</p></div>
        <div><h4>Under the hood</h4><p>{s.tech}</p></div>
        <div><h4>Stops the payment if it fails</h4><ul className="codes">{s.fails.map((f) => <li key={f}><code>{f}</code></li>)}</ul></div>
        <div className="lx-step-nav">
          <button className="lx-btn ghost dark" onClick={() => setI((n) => Math.max(0, n - 1))} disabled={i === 0}>Previous step</button>
          <button className="lx-btn solid" onClick={() => setI((n) => Math.min(JOURNEY.length - 1, n + 1))} disabled={i === JOURNEY.length - 1}>Next step</button>
        </div>
      </div>
    </section>
  );
}

// ---------- E. The bigger vision ----------

function Vision() {
  return (
    <section className="lx-vision" aria-labelledby="lx-vision-h">
      <h2 id="lx-vision-h" className="lx-display">Soon, agents will do business with other agents.</h2>
      <ul className="lx-examples">
        <li><Glyph kind="agent" /><span>A hotel’s agent orders coffee from a roaster’s agent.</span></li>
        <li><Glyph kind="agent" /><span>One company’s agent pays another company’s invoice.</span></li>
        <li><Glyph kind="agent" /><span>Two agents agree a price, then settle it.</span></li>
        <li><Glyph kind="agent" /><span>An agent hires another agent to finish a job.</span></li>
      </ul>
      <p className="lx-vision-lede">Every one of these payments has two sides. ProxyProof makes both sides prove their authority before anything is paid.</p>
      <div className="lx-today">
        <div>
          <h3>Working today</h3>
          <ul>
            <li>Agents from Claude, ChatGPT, Grok, Gemini or any framework connect through the MCP connector or REST API. Tested live: Claude Code over MCP, and an independently written REST agent.</li>
            <li>Both sides verified and matched before a PayPal sandbox checkout opens.</li>
            <li>Live revocation, single-use permits, and a signed evidence bundle anyone can verify.</li>
          </ul>
        </div>
        <div>
          <h3>Next</h3>
          <ul>
            <li>Sub-delegation chains, for agents that hire other agents.</li>
            <li>An AP2 mandate adapter.</li>
            <li>OAuth for the MCP connector, and an AuthZEN policy interface.</li>
          </ul>
        </div>
      </div>
      <p className="lx-credit">ProxyProof builds on AP2, ACP, UCP, Visa Trusted Agent Protocol, Verifiable Intent, AuthZEN and PayPal’s own agent tools rather than replacing them, and claims no conformance it hasn’t tested. <Link to="/architecture">See what exists and what ProxyProof adds</Link>.</p>
    </section>
  );
}

// ---------- Page ----------

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
    <div className="lx">
      <header className="lx-top"><div className="lx-top-inner">
        <Link className="lx-brand" to="/" aria-label="ProxyProof home"><Wordmark size={32} /></Link><span className="spacer" />
        <Link className="lx-link" to="/architecture">Architecture</Link>
        <button className="lx-btn solid sm" onClick={open} disabled={busy}>{me.user ? 'Open dashboard' : 'Explore Live Demo'}</button>
      </div></header>
      <main id="main">
        <Hero onDemo={open} busy={busy} />
        {error && <p className="notice error lx-error" role="alert">{error}</p>}
        <TrustGap />
        <Contrast />
        <Journey />
        <Vision />
        <section className="lx-final" aria-labelledby="lx-final-h">
          <div className="lx-final-mark" aria-hidden="true"><Monogram size={240} title="" /></div>
          <h2 id="lx-final-h" className="lx-display">Autonomous payments need more than intelligence. They need trust.</h2>
          <div className="lx-actions">
            <button className="lx-btn light" onClick={open} disabled={busy}>{busy ? 'Preparing the demo…' : 'Explore Live Demo'}</button>
            <Link className="lx-btn ghost" to="/architecture">Explore the Architecture</Link>
          </div>
        </section>
        <p className="lx-disclaimer">ProxyProof is an independent hackathon project, not affiliated with or endorsed by PayPal, Anthropic, OpenAI, xAI, Google, Visa or Mastercard. Product names are used only to describe compatibility. Payments use the PayPal sandbox and move no real money. ProxyProof enforces only the actions routed through it, and no system can promise to stop every fraud.</p>
      </main>
    </div>
  );
}
