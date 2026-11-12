import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Monogram } from '../Monogram';
import { usePrefersReducedMotion } from '../ui';
import '../hero.css';

/*
 * The two-world hero: "Claimed." (an agent's word) and "Proven." (what ProxyProof checks), with the
 * person / business / agent comparison on top. It plays one illustrative transaction; when both sides are
 * proven the whole section turns green. Every check it names is one the backend performs.
 */

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

export function Hero({ onDemo, busy }: { onDemo: () => void; busy: boolean }) {
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
    <div className="lxh"><section ref={heroRef} style={seam} className={`lx-hero${unified ? ' unified' : ''}`} aria-labelledby="lx-h1">
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
    </section></div>
  );
}

