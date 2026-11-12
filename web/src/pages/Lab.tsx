import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowRight, BadgeCheck, Bean, Bot, BotOff, CalendarCheck, CalendarDays, Check, CircleCheck, CircleDashed, CircleDollarSign, CloudOff, Coffee,
  ExternalLink, EyeOff, FastForward, FileDiff, FilePenLine, FileText, Ghost, Globe, Hotel, Hourglass, Landmark, LoaderCircle, OctagonPause,
  Info, Package, Pause, X, Receipt, Repeat2, RotateCw, ShoppingCart, Shuffle, Store, TriangleAlert, UserRound, UserRoundCheck, UserRoundX, VenetianMask, Wallet, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { api } from '../api';
import { Monogram, Wordmark } from '../Monogram';
import { useMe } from '../main';
import { usePrefersReducedMotion } from '../ui';
import '../lab.css';

/*
 * Scenario lab. The buyer's agent (left) is told what to do; the seller's agent (right) answers; the thing being paid for
 * slides in the centre with ProxyProof's verdict under it; the steps run along the bottom. Cool hues say who acted
 * (violet buyer's agent, deep purple Northwind's manager, plum seller's agent, dusk ProxyProof, blue PayPal, grey
 * world); green and orange say what happened. Every state comes from the run's snapshots, which are what ProxyProof's
 * verification returned after each step.
 */
type St = 'idle' | 'pass' | 'held' | 'review';
const COMP_ICON: Record<string, LucideIcon> = {
  genuine: BadgeCheck, 'payout-changed': Landmark, 'altered-in-transit': FilePenLine, 'different-totals': FileDiff, 'forged-mandate': VenetianMask,
  'lookalike-supplier': Ghost, 'prompt-injection': EyeOff, 'revoked-agent': BotOff, 'duplicate-payment': Repeat2, 'status-outage': CloudOff, 'wrong-item': Shuffle,
};
const PROMPT_ICON: Record<string, LucideIcon> = { purchase: Coffee, bill: Receipt, service: Wrench };
const ACTOR: Record<string, { label: string; cls: string }> = {
  SELLER_AGENT: { label: 'Seller’s agent', cls: 'a-seller' }, BUYER_AGENT: { label: 'Buyer’s agent', cls: 'a-buyer' }, BUYER_ORG: { label: 'Northwind manager', cls: 'a-person' },
  SELLER_ORG: { label: 'Harbor & Pine', cls: 'a-person' }, PROXYPROOF: { label: 'ProxyProof', cls: 'a-pp' }, EXECUTOR: { label: 'PayPal', cls: 'a-paypal' }, WORLD: { label: 'Meanwhile', cls: 'a-world' },
};
/** Plain-language reasons, keyed by ProxyProof's reason code (never by scenario). */
const WHY: Record<string, string> = {
  DESTINATION_NOT_AUTHORIZED: 'the invoice pays to an account the supplier never enrolled', DESTINATION_NOT_LINKED: 'the payout account is not the supplier’s enrolled account',
  TERMS_MODIFIED: 'the invoice changed after the seller’s agent signed it', TERMS_MISMATCH: 'the two agents signed different terms',
  DELEGATION_FORGED: 'the mandate was not signed by Northwind’s key', WRONG_ISSUER: 'the mandate was issued by someone else', SELF_DELEGATION: 'the agent signed its own mandate',
  ORG_NOT_ESTABLISHED: 'the supplier is not enrolled', COUNTERPARTY_NOT_APPROVED: 'the supplier is not one Northwind approved',
  CATEGORY_NOT_PERMITTED: 'the order includes something outside the agent’s mandate', AMOUNT_EXCEEDS_LIMIT: 'the amount is above the agent’s limit',
  LIVE_RECHECK_FAILED: 'the agent’s authority no longer holds', DELEGATION_REVOKED: 'the agent’s mandate was revoked', PERMIT_ALREADY_USED: 'that permit was already used',
  STATUS_UNAVAILABLE: 'the revocation status could not be checked', ACTION_NOT_PERMITTED: 'the agent may not do this', SIGNATURE_INVALID: 'the signature does not verify',
};
const STEP_MS = 1400;
/** The server formats money as “USD 238.00”; on screen it reads “$238.00”. */
const usd = (x?: string | null) => (x ? x.replace(/^USD\s?/, '$') : '');

const checkSt = (c: any): St => (!c ? 'idle' : c.state === 'pass' ? 'pass' : c.state === 'review' ? 'review' : ['fail', 'hold'].includes(c.state) ? 'held' : 'idle');
const worst = (xs: St[]): St => { const s = xs.filter((x) => x !== 'idle'); return s.includes('held') ? 'held' : s.includes('review') ? 'review' : s.length && s.length === xs.length ? 'pass' : s.length ? 'pass' : 'idle'; };
const Glyph = ({ st }: { st: St }) => st === 'pass' ? <CircleCheck className="g g-pass" aria-label="passed" /> : st === 'held' ? <OctagonPause className="g g-held" aria-label="held" /> : st === 'review' ? <Hourglass className="g g-review" aria-label="waiting for approval" /> : <CircleDashed className="g g-idle" aria-label="not checked yet" />;

function Fact({ icon: I, children, st }: { icon: LucideIcon; children: ReactNode; st: St }) {
  return <li className={`lb-fact s-${st}`}><I className="i" aria-hidden="true" /><span>{children}</span><Glyph st={st} /></li>;
}

function Avatar({ side }: { side: 'buyer' | 'seller' }) {
  return <span className={`lb-avatar ${side === 'buyer' ? 'a-buyer' : 'a-seller'}`} aria-hidden="true"><Bot /></span>;
}

function Banner({ p }: { p: any }) {
  const art = p.kind === 'purchase' ? <><Coffee className="big" /><Bean className="s1" /><Package className="s2" /></> : p.kind === 'bill' ? <><Receipt className="big" /><CalendarDays className="s1" /><Hotel className="s2" /></> : <><Wrench className="big rot" /><Coffee className="s1" /><CalendarCheck className="s2" /></>;
  return (
    <div className="lb-banner" role="group" aria-roledescription="slide" aria-label={p.title}>
      <div className="txt">
        <span className="eyebrow">{p.document === 'QUOTE' ? 'Quote' : 'Invoice'} {p.reference} · Harbor & Pine Roasters</span>
        <strong className="title">{p.title}</strong>
        <span className="line">{p.lines.map((l: any) => `${l.quantity} × ${l.name}`).join(', ')}</span>
        <span className="price">{usd(p.total)}{p.kind === 'bill' && <em>above $250: manager approves</em>}</span>
      </div>
      <div className="art" aria-hidden="true">{art}</div>
    </div>
  );
}

export function Lab() {
  const nav = useNavigate();
  const { refresh } = useMe();
  const reduce = usePrefersReducedMotion();
  const [cat, setCat] = useState<any>(null);
  const [prompt, setPrompt] = useState('buy-coffee');
  const [comp, setComp] = useState('genuine');
  const [run, setRun] = useState<any>(null);
  const [k, setK] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // The "why" popup opens once a run has fully played out (allowed, held, or waiting for a person).
  const [why, setWhy] = useState(false);
  useEffect(() => { if (run && k >= run.steps.length && !busy) setWhy(true); }, [run, k, busy]);
  useEffect(() => {
    if (!why) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setWhy(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [why]);

  useEffect(() => { api.get('/api/lab/scenarios').then(setCat).catch((e) => setError(e.message)); }, []);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  /** Reveal steps from `from` to the end, one every STEP_MS. */
  const reveal = (r: any, from: number) => {
    stop();
    if (reduce) { setK(r.steps.length); return; }
    let n = from + 1; setK(n);
    timer.current = window.setInterval(() => { n += 1; if (n > r.steps.length) { stop(); return; } setK(n); }, STEP_MS);
  };
  const start = async (p: string, c: string) => {
    stop(); setWhy(false); setBusy(true); setError(null); setRun(null); setK(0);
    try { const r = await api.post('/api/lab/runs', { prompt: p, complication: c }); setRun(r); reveal(r, 0); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const pickPrompt = (id: string) => { setPrompt(id); const ok = cat.plans[`${id}:${comp}`]; const c = ok ? comp : 'genuine'; setComp(c); start(id, c); };
  const pickComp = (id: string) => { if (!cat.plans[`${prompt}:${id}`]) return; setComp(id); if (run) start(prompt, id); else { setRun(null); setK(0); } };
  const approve = async () => {
    setWhy(false); setBusy(true); setError(null);
    try { const before = run.steps.length; const r = await api.post(`/api/lab/runs/${run.id}/approve`); setRun(r); reveal(r, before); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const capture = async () => { setBusy(true); try { setRun({ ...(await api.post(`/api/lab/runs/${run.id}/capture`)) }); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const sync = async () => { setBusy(true); try { setRun(await api.get(`/api/lab/runs/${run.id}?sync=1`)); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const leave = async () => { await api.post('/api/auth/logout').catch(() => {}); await refresh(); nav('/'); };

  const revealing = !!run && k < run.steps.length;
  const shown = run && k > 0 ? run.steps[Math.min(k, run.steps.length) - 1] : null;
  const settled = !!run && !revealing;
  const tx = settled && run.current?.tx ? run.current.tx : shown?.tx ?? null;
  const acting = revealing || busy ? shown?.actor ?? null : null;

  const v = useMemo(() => {
    const side = (who: 'buyer' | 'seller') => { const cs: any[] = tx?.[who]?.checks ?? []; return (k: string) => cs.find((c) => c.key === k); };
    const b = side('buyer'), s = side('seller');
    const m = (key: string) => (tx?.match ?? []).find((c: any) => c.key === key);
    const g = (...cs: any[]) => worst(cs.map(checkSt));
    const buyerChecked = (tx?.buyer?.checks ?? []).length > 0;
    const buyerAllPass = buyerChecked && (tx.buyer.checks as any[]).every((c) => c.state === 'pass');
    const review = m('review') ? checkSt(m('review')) : buyerAllPass ? 'pass' as St : 'idle' as St;
    const permits = tx?.permits ?? [];
    const payment: St = !tx?.payment ? 'idle' : ['FAILED', 'CANCELLED'].includes(tx.payment_state) ? 'held' : 'pass';
    return {
      b, s, m, review,
      buyer: { id: g(b('identity'), b('signature'), b('replay')), org: g(b('organization')), mandate: g(b('delegation'), b('validity')), limits: g(b('scope'), b('counterparty')), scope: g(b('scope')), cp: g(b('counterparty')) },
      seller: { id: g(s('identity'), s('signature'), s('replay')), org: g(s('organization')), mandate: g(s('delegation'), s('validity'), s('scope'), s('counterparty')), payout: g(s('destination')), cp: g(s('counterparty')), scope: g(s('scope')) },
      // “Waiting for the buyer to sign” is not a problem with the terms, so it does not colour the pill.
      both: { terms: g(m('seller_terms'), m('buyer_terms')?.code === 'BUYER_AUTHORIZATION_PENDING' ? null : m('buyer_terms'), m('expiry')), permit: (permits.length ? 'pass' : 'idle') as St, paypal: payment },
    };
  }, [tx]);

  if (!cat) return <div className="lb-splash">{error ? <p className="notice error">{error}</p> : <Monogram size={72} animate />}</div>;
  const P = cat.prompts.find((p: any) => p.id === prompt);
  const C = cat.complications.find((c: any) => c.id === comp);
  const plan: any[] = cat.plans[`${prompt}:${comp}`] ?? [];
  const pIndex = cat.prompts.findIndex((p: any) => p.id === prompt);
  const buyerCard = shown?.buyer_agent, sellerCard = shown?.seller_agent;
  const sellerName = sellerCard?.name ?? (comp === 'lookalike-supplier' ? 'Bayside Sales Agent' : 'Harbor & Pine Sales Agent');
  const sellerOrg = sellerCard?.organization.name ?? (comp === 'lookalike-supplier' ? 'Bayside Trading Co.' : 'Harbor & Pine Roasters');
  const terms = tx?.terms;

  // The ProxyProof card's state.
  const out = run?.outcome;
  const firstStop = out?.stops?.[0];
  const phase: 'idle' | 'running' | 'review' | 'held' | 'allowed' =
    !run ? (busy ? 'running' : 'idle') : revealing || busy ? 'running' : run.awaiting ? 'review' : out?.caught_at ? 'held' : 'allowed';
  const stopCode = phase === 'held' ? (out.stops[0]?.code ?? out.caught_at?.code) : null;
  const finalCode = phase === 'held' ? out.caught_at?.code : null;
  const headline = phase === 'idle' ? 'Nothing to verify yet'
    : phase === 'running' ? 'Checking both sides…'
      : phase === 'review' ? 'Waiting for a Northwind manager'
        : phase === 'held' ? `${finalCode === 'PERMIT_ALREADY_USED' ? 'Second payment held' : 'Payment held'}: ${WHY[finalCode] ?? WHY[stopCode] ?? 'a check did not pass'}`
          : out?.cleared_after ? `Payment allowed after ${out.cleared_after.decision === 'REVIEW' ? 'approval' : 'recheck'}` : 'Payment allowed';
  const sub = phase === 'idle' ? 'Tell the buyer’s agent what to do. Every run makes fresh agents and keys; ProxyProof’s real checks decide.'
    : phase === 'running' ? (shown?.say ?? 'The agents are starting.')
      : phase === 'review' ? `${run.awaiting.approver} must approve these exact terms: ${usd(tx?.amount)}, ${terms?.document === 'QUOTE' ? 'quote' : 'invoice'} ${terms?.reference ?? ''}.`
        : phase === 'held' ? `Stopped at step ${out.caught_at.step}. ${out.caught_at.result}`
          : out?.cleared_after ? `Paused at step ${out.cleared_after.step}; once resolved, both agents were proven again on live state.` : 'Both agents proven and signed the same terms. Single-use permit issued.';
  const money = tx?.payment_state === 'COMPLETED' ? `PayPal confirmed · ${usd(tx.amount)} paid`
    : tx?.payment_state === 'AWAITING_BUYER_APPROVAL' ? (finalCode === 'PERMIT_ALREADY_USED' ? 'Checkout opened once · the retry never reached PayPal' : `Checkout open on PayPal · waiting for the buyer to approve ${usd(tx.amount)}`)
      : 'No money has moved.';

  // The bridge in the banner: each agent's signature over the terms, meeting at ProxyProof.
  const sellerSigned = v.s('signature')?.state === 'pass';
  const buyerSigned = v.b('signature')?.state === 'pass';
  const termsBad = ['fail'].includes(v.m('seller_terms')?.state) || ['fail'].includes(v.m('buyer_terms')?.state);
  const termsOk = v.m('buyer_terms')?.state === 'pass';


  return (
    <div className="lb">
      <header className="lb-top"><div className="lb-top-inner">
        <Link className="lb-brand" to="/" aria-label="ProxyProof home"><Wordmark size={30} ring /></Link>
        <span className="lb-sep" aria-hidden="true" />
        <span className="lb-title">Scenario lab</span>
        <span className="spacer" />
        <Link className="lb-link" to="/app/console">Console</Link>
        <Link className="lb-link hide-sm" to="/architecture">Architecture</Link>
        <button className="lb-link as-btn" onClick={leave}>Leave demo</button>
      </div></header>

      <main className="lb-main">
        <section className="lb-comps" aria-label="Today’s complication">
          <span className="lb-label">Today’s complication</span>
          <div className="chips">
            {cat.complications.map((c: any) => {
              const I = COMP_ICON[c.id] ?? BadgeCheck;
              const allowed = !!cat.plans[`${prompt}:${c.id}`];
              return <button key={c.id} className={`lb-chip k-${c.kind}`} aria-pressed={c.id === comp} disabled={!allowed || busy} title={allowed ? c.story : 'Only applies to purchases'} onClick={() => pickComp(c.id)}><I aria-hidden="true" />{c.title}</button>;
            })}
          </div>
          {C && <p className="lb-realworld"><strong>{C.title}.</strong> {C.story} {C.real_world && <span className="src">Real world · {C.real_world.text} <a href={C.real_world.url} target="_blank" rel="noreferrer">{C.real_world.source}<ExternalLink aria-hidden="true" /></a></span>}</p>}
        </section>
        {error && <p className="notice error" role="alert">{error}</p>}

        <div className="lb-cols">
          {/* Buyer's agent */}
          <section className={`lb-card lb-side${acting === 'BUYER_AGENT' ? ' ring-buyer' : acting === 'BUYER_ORG' ? ' ring-person' : ''}`} aria-label="Buyer’s agent">
            <div className="lb-who">
              <Avatar side="buyer" />
              <div><strong>{buyerCard?.name ?? 'Northwind Procurement Agent'}</strong><span>acts for Northwind Hotels</span></div>
              <span className={`lb-pill ${buyerCard?.state === 'REVOKED' ? 'held' : v.buyer.mandate === 'held' ? 'held' : 'ok'}`}>{buyerCard?.state === 'REVOKED' ? 'Revoked' : v.buyer.mandate === 'held' ? 'Mandate not genuine' : 'Authorized'}</span>
            </div>
            <ul className="lb-facts">
              <Fact icon={ShoppingCart} st={v.buyer.scope}>Coffee & machine service</Fact>
              <Fact icon={CircleDollarSign} st={v.buyer.scope}>Up to $500 per payment</Fact>
              <Fact icon={Store} st={v.buyer.cp}>Harbor & Pine only</Fact>
              <Fact icon={UserRoundCheck} st={v.review}>Manager approves above $250</Fact>
            </ul>
            <span className="lb-label">Tell the agent to…</span>
            <div className="lb-prompts">
              {cat.prompts.map((p: any) => {
                const I = PROMPT_ICON[p.kind];
                const on = p.id === prompt;
                return <button key={p.id} className="lb-prompt" aria-pressed={on} disabled={busy} onClick={() => pickPrompt(p.id)}><I aria-hidden="true" /><span>{p.prompt}</span>{busy && on ? <LoaderCircle className="spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}</button>;
              })}
            </div>
            <p className="lb-foot"><Wallet aria-hidden="true" />Pays from Northwind’s PayPal (sandbox)</p>
          </section>

          {/* Centre: what is being paid for, then ProxyProof */}
          <div className="lb-centre">
            <div className="lb-carousel" aria-roledescription="carousel" aria-label="What Northwind is paying for">
              <div className="track" style={{ transform: `translateX(-${pIndex * 100}%)` }}>
                {cat.prompts.map((p: any) => <Banner key={p.id} p={p} />)}
              </div>
              <div className={`lb-bridge${termsBad ? ' bad' : ''}`} aria-hidden="true">
                <span className="end">{buyerSigned ? (v.m('buyer_terms')?.state === 'fail' ? 'Buyer signed different terms' : `Buyer signed ${usd(tx?.amount)}`) : 'Buyer’s agent'}{buyerSigned && <Check />}</span>
                <span className={`half l${buyerSigned ? ' on' : ''}`} />
                <span className={`hub${termsOk ? ' ok' : termsBad ? ' bad' : ''}`}><Monogram size={20} title="" /></span>
                <span className={`half r${sellerSigned ? ' on' : ''}`} />
                <span className="end r">{sellerSigned ? (v.m('seller_terms')?.state === 'fail' ? 'Changed after signing' : `Seller signed ${v.m('seller_terms')?.state === 'pass' ? usd(tx?.amount) : ''}`) : 'Seller’s agent'}{sellerSigned && <Check />}</span>
              </div>
              <div className="dots" aria-hidden="true">{cat.prompts.map((p: any, i: number) => <i key={p.id} className={i === pIndex ? 'on' : ''} />)}</div>
            </div>

            <section className={`lb-pp ph-${phase}`} aria-live="polite" aria-label="ProxyProof">
              <div className="band">
                <span className="name"><Monogram size={22} title="" />ProxyProof</span>
                <span className="pill">{phase === 'idle' ? 'Ready' : phase === 'running' ? <><LoaderCircle className="spin" aria-hidden="true" />Checking…</> : phase === 'review' ? 'Waiting for approval' : phase === 'held' ? 'Held' : 'Allowed'}</span>
                {revealing && <button className="icon-btn" onClick={() => { stop(); setK(run.steps.length); }} title="Skip to result"><FastForward aria-hidden="true" /><span className="sr-only">Skip to result</span></button>}
                {settled && <button className="why-btn" onClick={() => setWhy(true)}><Info aria-hidden="true" />Why?</button>}
                {settled && !run.awaiting && <button className="icon-btn" onClick={() => start(prompt, comp)} disabled={busy} title="Run again"><RotateCw aria-hidden="true" /><span className="sr-only">Run again</span></button>}
              </div>
              {phase === 'running' && <div className="progress" aria-hidden="true" />}
              <div className="body">
                <h1 className="head">{headline}</h1>
                <p className="sub">{sub}{phase === 'held' && finalCode && <code>{finalCode}</code>}</p>
                {phase === 'review' && (
                  <div className="approve">
                    <span className="person"><UserRound aria-hidden="true" /></span>
                    <button className="btn-approve" onClick={approve} disabled={busy}>{busy ? 'Approving…' : `Approve these terms as ${run.awaiting.approver.split(',')[0]}`}</button>
                  </div>
                )}
                <div className="pills">
                  <span className="grp a-buyer">Buyer’s agent</span>
                  <Pill st={v.buyer.id}>Identity</Pill><Pill st={v.buyer.org}>Enrolled</Pill><Pill st={v.buyer.mandate}>Mandate</Pill><Pill st={v.buyer.limits}>Limits</Pill>
                  <span className="grp a-seller">Seller’s agent</span>
                  <Pill st={v.seller.id}>Identity</Pill><Pill st={v.seller.org}>Enrolled</Pill><Pill st={v.seller.mandate}>Mandate</Pill><Pill st={v.seller.payout}>Payout</Pill>
                  <span className="grp a-pp">Both</span>
                  <Pill st={v.both.terms}>Same terms</Pill><Pill st={v.review}>{!v.m('review') && v.review === 'pass' ? 'No approval needed' : 'Approval'}</Pill><Pill st={v.both.permit}>Permit</Pill><Pill st={v.both.paypal}>PayPal</Pill>
                </div>
              </div>
              <div className="money">
                <Wallet aria-hidden="true" /><span>{money}</span>
                {settled && tx?.payment_state === 'AWAITING_BUYER_APPROVAL' && tx.payment?.payer_link && finalCode !== 'PERMIT_ALREADY_USED' && (
                  <span className="pay-actions">
                    <a className="btn-paypal" href={tx.payment.payer_link} target="_blank" rel="noreferrer">Approve as buyer on PayPal<ExternalLink aria-hidden="true" /></a>
                    <button className="btn-ghost" onClick={capture} disabled={busy}>Capture after approval</button>
                    <button className="icon-btn dark" onClick={sync} disabled={busy} title="Refresh PayPal status"><RotateCw aria-hidden="true" /><span className="sr-only">Refresh PayPal status</span></button>
                  </span>
                )}
              </div>
              {settled && !run.awaiting && C && <p className="without"><strong>Without ProxyProof:</strong> {C.without}</p>}
            </section>
          </div>

          {/* Seller's agent */}
          <section className={`lb-card lb-side${acting === 'SELLER_AGENT' ? ' ring-seller' : ''}`} aria-label="Seller’s agent">
            <div className="lb-who">
              <Avatar side="seller" />
              <div><strong>{sellerName}</strong><span>acts for {sellerOrg}</span></div>
              <span className={`lb-pill ${sellerCard?.organization.status === 'UNVERIFIED' || comp === 'lookalike-supplier' ? 'held' : 'ok'}`}>{sellerCard?.organization.status === 'UNVERIFIED' || (comp === 'lookalike-supplier' && !sellerCard) ? 'Not enrolled' : 'Authorized'}</span>
            </div>
            <ul className="lb-facts">
              <Fact icon={FileText} st={v.seller.scope}>Quote & invoice</Fact>
              <Fact icon={CircleDollarSign} st={v.seller.scope}>Up to $2,000</Fact>
              <Fact icon={Hotel} st={v.seller.cp}>Customer: Northwind Hotels</Fact>
              <Fact icon={Wallet} st={v.seller.payout}>Paid only to its enrolled PayPal</Fact>
            </ul>
            <div className="lb-invoice">
              <span className="lb-label">{terms?.document === 'QUOTE' ? 'Quote it sends' : 'Invoice it sends'}</span>
              {terms ? (
                <dl>
                  <div><dt>Reference</dt><dd>{terms.reference}</dd></div>
                  <div className={v.seller.payout === 'held' ? 'bad' : ''}><dt>Pays to</dt><dd>{v.seller.payout === 'held' && <TriangleAlert aria-hidden="true" />}{terms.payment_destination}{v.seller.payout === 'held' && <small>enrolled account is {sellerCard?.organization.payout_account}</small>}</dd></div>
                  <div className={v.m('seller_terms')?.state === 'fail' ? 'bad' : ''}><dt>Total</dt><dd>{usd(tx.amount)}{v.m('seller_terms')?.state === 'fail' && <small>not what the seller’s agent signed</small>}</dd></div>
                  <div><dt>Signature</dt><dd>{sellerSigned ? 'Signed with its own key' : v.seller.id === 'held' ? 'Does not verify' : '—'}</dd></div>
                </dl>
              ) : <p className="empty">Nothing sent yet.</p>}
            </div>
            <p className="lb-foot"><Landmark aria-hidden="true" />Enrolled payout registered by the business, not the agent</p>
          </section>
        </div>

      </main>

      {why && settled && (() => {
        const st = phase === 'held' ? 'held' : phase === 'review' ? 'review' : 'allowed';
        const Icon = st === 'held' ? OctagonPause : st === 'review' ? Hourglass : CircleCheck;
        const code = finalCode ?? (st === 'review' ? 'REVIEW_REQUIRED' : null);
        const allowedWhy = [
          'Both agents proved who they are with their own signatures.',
          'Northwind and Harbor & Pine each genuinely approved their agent, and neither approval has expired or been revoked.',
          'The amount is within the buyer’s limit, the supplier is approved, and the money goes to the account the seller registered.',
          'Both agents signed exactly the same terms.',
        ];
        return (
          <div className="why-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setWhy(false); }}>
            <div className={`why why-${st}`} role="dialog" aria-modal="true" aria-labelledby="why-h">
              <button className="why-x" onClick={() => setWhy(false)} aria-label="Close"><X /></button>
              <div className="why-top">
                <span className="why-icon"><Icon aria-hidden="true" /></span>
                <div>
                  <span className="why-kicker">{st === 'held' ? 'Payment held' : st === 'review' ? 'Waiting for approval' : out?.cleared_after ? 'Payment allowed after a pause' : 'Payment allowed'}</span>
                  <h2 id="why-h">{st === 'held' ? `Stopped because ${WHY[finalCode] ?? WHY[stopCode] ?? 'a check did not pass'}.` : st === 'review' ? `This bill is above Northwind’s $250 approval line, so a person must approve the exact terms.` : 'Both sides are proven, so the payment can go ahead.'}</h2>
                </div>
              </div>
              <div className="why-body">
                {st === 'allowed' && <ul className="why-list">{allowedWhy.map((t) => <li key={t}><Check aria-hidden="true" />{t}</li>)}</ul>}
                {st === 'held' && <p><strong>What ProxyProof found:</strong> {out?.caught_at?.result}</p>}
                {st === 'review' && <p>{run.awaiting.approver} approves with Northwind’s own key. Until then, no permit is issued and no money can move.</p>}
                {code && <p className="why-code">Reason code <code>{code}</code></p>}
                <p className="why-next"><strong>{st === 'held' ? 'Money:' : 'Next:'}</strong> {st === 'held' ? (tx?.payment_state === 'AWAITING_BUYER_APPROVAL' ? 'only the first checkout exists; the repeat never reached PayPal.' : 'no money moved and no PayPal order was created.') : st === 'review' ? 'press “Approve these terms” on the ProxyProof card.' : 'the buyer approves the checkout on PayPal; it counts as paid only when PayPal confirms.'}</p>
                {C?.real_world && <p className="why-real"><strong>Real world:</strong> {C.real_world.text} <a href={C.real_world.url} target="_blank" rel="noreferrer">{C.real_world.source}</a></p>}
                {C && st !== 'review' && <p className="why-real"><strong>Without ProxyProof:</strong> {C.without}</p>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function Pill({ st, children }: { st: St; children: ReactNode }) {
  return <span className={`lb-check s-${st}`}><Glyph st={st} />{children}</span>;
}
