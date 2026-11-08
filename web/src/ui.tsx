import { Link } from 'react-router-dom';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, money, when } from './api';

export const DECISION_WORD: Record<string, string> = { ALLOW: 'Allowed', REVIEW: 'Needs review', HOLD: 'Held', DENY: 'Denied' };
export const STATUS_WORD: Record<string, string> = {
  RECEIVED: 'Received', EXTRACTING: 'Reading files', INVESTIGATING: 'Investigating', EVALUATED: 'Evaluated', READY_FOR_CONFIRMATION: 'Ready to pay', AWAITING_REVIEW: 'Awaiting review',
  ON_HOLD: 'On hold', DENIED: 'Denied', EXECUTING: 'Sending', PAYMENT_PENDING: 'Payment pending', COMPLETED: 'Paid', FAILED: 'Payment failed', REJECTED: 'Rejected',
};
const STATUS_TONE: Record<string, string> = { READY_FOR_CONFIRMATION: 'ALLOW', COMPLETED: 'COMPLETED', AWAITING_REVIEW: 'REVIEW', ON_HOLD: 'HOLD', DENIED: 'DENY', FAILED: 'FAILED', REJECTED: 'DENY', PAYMENT_PENDING: 'PENDING', EXECUTING: 'PENDING' };

export const Chip = ({ tone, children, plain }: { tone?: string; children: ReactNode; plain?: boolean }) => <span className={`chip ${tone ?? ''}${plain ? ' plain' : ''}`}>{children}</span>;
export const DecisionChip = ({ d }: { d?: string | null }) => d ? <Chip tone={d}>{DECISION_WORD[d] ?? d}</Chip> : <Chip tone="NEUTRAL">No decision</Chip>;
export const StatusChip = ({ s }: { s: string }) => <Chip tone={STATUS_TONE[s] ?? 'NEUTRAL'}>{STATUS_WORD[s] ?? s}</Chip>;

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api.get<T>(path)); setError(null); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

export const Loading = ({ lines = 3 }: { lines?: number }) => <div className="stack-sm" aria-busy="true" aria-label="Loading">{Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ width: `${90 - i * 14}%`, height: i === 0 ? 34 : 18 }} />)}</div>;
export const ErrorNote = ({ error, retry }: { error: string; retry?: () => void }) => <div className="notice error row" role="alert"><span style={{ flex: 1 }}>{error}</span>{retry && <button className="btn btn-sm btn-secondary" onClick={retry}>Try again</button>}</div>;

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2 className="h3">{title}</h2>
        {children}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(m: string) => void>(() => {});
export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((m: string) => { setMsg(m); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setMsg(null), 3200); }, []);
  return <ToastCtx.Provider value={show}>{children}{msg && <div className="toast" role="status">{msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

export function Dropzone({ files, setFiles, accept = '.pdf,.png,.jpg,.jpeg,.eml,application/pdf,image/png,image/jpeg,message/rfc822' }: { files: File[]; setFiles: (f: File[]) => void; accept?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const add = (list: FileList | null) => list && setFiles([...files, ...Array.from(list)].slice(0, 5));
  return (
    <div>
      <div className={`drop${over ? ' over' : ''}`} role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
        <strong>Drop an invoice or email here</strong>
        <span className="muted small">PDF, PNG, JPG or .eml, up to 10 MB each. Add the email and the invoice together if you have both.</span>
        <input ref={input} type="file" multiple accept={accept} className="sr-only" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      </div>
      {files.length > 0 && <div className="files">{files.map((f, i) => (
        <div className="file" key={i}><span style={{ overflowWrap: 'anywhere' }}>{f.name} <span className="muted tiny">{(f.size / 1024).toFixed(0)} KB</span></span>
          <button className="btn btn-sm btn-quiet" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>Remove</button></div>))}</div>}
    </div>
  );
}

/** Transaction states as people should read them. ALLOWED is a policy permission; COMPLETED means PayPal confirmed it. */
export const OUTCOME: Record<string, { label: string; color: string; help: string }> = {
  ALLOWED: { label: 'Allowed', color: 'var(--allow)', help: 'Policy permits it. Not paid until someone releases it.' },
  UNDER_REVIEW: { label: 'Under review', color: 'var(--review)', help: 'A person’s decision or more evidence is needed.' },
  HELD: { label: 'Held', color: '#e08a00', help: 'Cannot proceed until a verification is resolved.' },
  DENIED: { label: 'Denied', color: 'var(--deny)', help: 'Breaks a security rule or authorization boundary.' },
  PROCESSING: { label: 'Processing', color: 'var(--proc)', help: 'Released. Waiting for PayPal to confirm.' },
  COMPLETED: { label: 'Completed', color: 'var(--done)', help: 'PayPal confirmed the payment.' },
  FAILED: { label: 'Payment failed', color: 'var(--deny)', help: 'PayPal did not complete it.' },
  NOT_EVALUATED: { label: 'Not evaluated', color: 'var(--proc)', help: '' },
};
export const OutcomeChip = ({ o }: { o: string }) => <span className={`chip o-${o}`} title={OUTCOME[o]?.help}>{OUTCOME[o]?.label ?? o}</span>;

export const AgentIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="4.5" width="11" height="8.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2v2.5M6 8.5h.01M10 8.5h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>;
export const PersonIcon = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.5" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M2.8 14c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;

export type ActivityRow = {
  id: string; reference: string | null; payee: string; amount_minor: number | null; currency: string | null; initiator: { kind: 'AGENT' | 'HUMAN'; name: string };
  outcome: string; reason: string; moreReasons: number; indicators: { key: string; label: string }[]; nextAction: string | null; created_at: string; sample: boolean; providerRef: string | null;
};

export function Activity({ rows, empty }: { rows: ActivityRow[]; empty?: ReactNode }) {
  if (!rows.length) return <div className="acts"><div className="empty">{empty ?? <p>No transactions match.</p>}</div></div>;
  return (
    <div className="acts" role="list">
      {rows.map((r) => (
        <Link key={r.id} to={`/app/transactions/${r.id}`} className="act" role="listitem">
          <span className={`rail o-${r.outcome}`} aria-hidden="true" />
          <div className="main">
            <div className="top"><span className="payee">{r.payee}</span><span className="ref">{r.reference ?? 'No invoice reference'}</span></div>
            <div className="why">{r.reason}{r.moreReasons > 0 && <span className="more"> +{r.moreReasons} more</span>}</div>
            <div className="meta">
              <span className="who-ic">{r.initiator.kind === 'AGENT' ? <AgentIcon /> : <PersonIcon />}{r.initiator.name}</span>
              <span>{when(r.created_at)}</span>
              {r.indicators.map((i) => <span key={i.key} className="tag">{i.label}</span>)}
              {r.sample && <span className="tag sample" title="Created with the demo workspace and decided live by the policy engine">Sample</span>}
              {r.nextAction && <span className="next">Next: {r.nextAction}</span>}
            </div>
          </div>
          <div className="side-col"><span className="amt">{money(r.amount_minor, r.currency ?? 'USD')}</span><OutcomeChip o={r.outcome} /></div>
        </Link>
      ))}
    </div>
  );
}

const CK_ICON: Record<string, ReactNode> = {
  pass: <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  fail: <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
  warn: <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5v4.2M6 9.2h.01" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>,
  na: <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>,
};
const CK_WORD: Record<string, string> = { pass: 'Verified', fail: 'Did not match', warn: 'Warning', na: 'Not applicable' };
export function Checklist({ checks }: { checks: { key: string; label: string; state: string; detail: string }[] }) {
  if (!checks?.length) return <p className="muted small">No checks were recorded for this request.</p>;
  return <div className="checks">{checks.map((c) => <div key={c.key} className={`ck ${c.state}`}><span className="ic" role="img" aria-label={CK_WORD[c.state]}>{CK_ICON[c.state]}</span><span className="lb">{c.label}</span><span className="dt">{c.detail}</span></div>)}</div>;
}
