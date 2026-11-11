import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';

export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await api.get<T>(path)); setError(null); } catch (e: any) { setError(e.message); }
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, reload };
}

export const usePrefersReducedMotion = () => {
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduce(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return reduce;
};

export type Action = 'MAKE' | 'COLLECT';
export const PERSPECTIVE: Record<Action, { label: string; text: string }> = {
  MAKE: { label: 'Seller perspective', text: 'A seller receives a purchase from a buyer’s AI agent. Is that agent really authorized by the buyer to make this purchase, at this amount, from this seller?' },
  COLLECT: { label: 'Buyer perspective', text: 'A buyer receives a quote or invoice from a seller’s AI agent. Is that agent really authorized by the business to issue it, and to be paid at that account?' },
};

/**
 * "Is this AI agent authorized to [MAKE / COLLECT] payment?" Only the action word moves, inside a fixed slot.
 * Screen readers get the whole question once. With reduced motion, both words are shown and nothing animates.
 */
export function Question({ action, as: Tag = 'h1', className = '' }: { action: Action; as?: 'h1' | 'h2'; className?: string }) {
  const reduce = usePrefersReducedMotion();
  const [state, setState] = useState<{ current: Action; prev: Action | null; n: number }>({ current: action, prev: null, n: 0 });
  const refs = { MAKE: useRef<HTMLSpanElement>(null), COLLECT: useRef<HTMLSpanElement>(null) };
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => { if (action !== state.current) setState((s) => ({ current: action, prev: s.current, n: s.n + 1 })); }, [action]); // eslint-disable-line react-hooks/exhaustive-deps
  // The slot takes the width of the word it shows and eases between widths, so "payment?" never jumps or gaps.
  useLayoutEffect(() => {
    const measure = () => setWidth(refs[state.current].current?.offsetWidth ?? null);
    measure();
    window.addEventListener('resize', measure);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => window.removeEventListener('resize', measure);
  }, [state.current]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Tag className={`q ${className}`}>
      <span className="sr-only">Is this AI agent authorized to make or collect payment?</span>
      <span aria-hidden="true">
        Is this AI agent authorized to{' '}
        {reduce ? <span className="word-static">make or collect</span> : (
          <span className="slot" style={width ? { width } : undefined}>
            <span className="measure"><span ref={refs.MAKE}>MAKE</span><span ref={refs.COLLECT}>COLLECT</span></span>
            {state.prev && <span key={`out-${state.n}`} className="w out">{state.prev}</span>}
            <span key={`in-${state.n}`} className={`w in${state.n === 0 ? ' first' : ''}`}>{state.current}</span>
          </span>
        )}{' '}payment?
      </span>
    </Tag>
  );
}

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
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h2>{title}</h2><button className="btn btn-quiet btn-sm" onClick={onClose} aria-label="Close">Close</button></div>
        {children}
      </div>
    </div>
  );
}

const STATE_WORD: Record<string, string> = {
  AUTHORIZED: 'Authorized', CONNECTED: 'Connected, not authorized', PENDING_APPROVAL: 'Awaiting approval', EXPIRED: 'Expired', REVOKED: 'Revoked',
  ALLOW: 'Allow', HOLD: 'Hold', REVIEW: 'Review', DENY: 'Deny', VERIFIED: 'Enrolled', UNVERIFIED: 'Not enrolled',
  NOT_STARTED: 'No payment yet', AWAITING_BUYER_APPROVAL: 'Awaiting buyer on PayPal', CAPTURE_SUBMITTED: 'Capture submitted', COMPLETED: 'Paid (PayPal confirmed)', FAILED: 'Payment failed', CANCELLED: 'Cancelled',
  pass: 'Pass', hold: 'Hold', review: 'Review', fail: 'Fail', not_reached: 'Not reached',
};
export const Chip = ({ v }: { v: string }) => <span className={`chip ${v}`}>{STATE_WORD[v] ?? v}</span>;
