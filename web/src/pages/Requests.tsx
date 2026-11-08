import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, toMinor } from '../api';
import { can, useMe } from '../main';
import { Activity, Dropzone, ErrorNote, Loading, useLoad, type ActivityRow } from '../ui';

const FILTERS: [string, string][] = [['ALL', 'All'], ['ALLOWED', 'Allowed'], ['UNDER_REVIEW', 'Under review'], ['HELD', 'Held'], ['DENIED', 'Denied'], ['PROCESSING', 'Processing'], ['COMPLETED', 'Completed'], ['FAILED', 'Payment failed']];

export function Transactions() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const { me } = useMe();
  const list = useLoad<any>('/api/transactions');
  const [open, setOpen] = useState(params.get('new') === '1');
  useEffect(() => { if (params.get('new') === '1') setOpen(true); }, [params]);
  const status = params.get('status') ?? 'ALL';
  const risk = params.get('risk');
  const who = params.get('who') ?? 'ALL';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(params); if (v === null || v === 'ALL') n.delete(k); else n.set(k, v); n.delete('new'); setParams(n, { replace: true }); };
  const rows: ActivityRow[] = list.data?.transactions ?? [];
  const shown = rows.filter((r) => (status === 'ALL' || r.outcome === status) && (!risk || r.indicators.some((i) => i.key === risk)) && (who === 'ALL' || r.initiator.kind === who));
  const riskLabel = risk ? rows.flatMap((r) => r.indicators).find((i) => i.key === risk)?.label ?? risk : null;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1 className="h1">Transactions</h1><p className="lead">Every payment request, why it was allowed or stopped, and whether money moved. Open one to see the evidence.</p></div>
        {can(me.user?.role, ['OWNER', 'FINANCE_ADMIN', 'REVIEWER']) && !open && <button className="btn btn-primary" onClick={() => setOpen(true)}>Upload an invoice</button>}
      </div>
      {open && <NewRequest onDone={(id) => nav(`/app/transactions/${id}`)} onCancel={() => { setOpen(false); set('new', null); }} />}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="seg" role="group" aria-label="Filter by status">{FILTERS.filter(([k]) => k !== 'FAILED' || rows.some((r) => r.outcome === 'FAILED')).map(([k, l]) => <button key={k} aria-pressed={status === k} onClick={() => set('status', k)}>{l}<span className="n">{k === 'ALL' ? rows.length : rows.filter((r) => r.outcome === k).length}</span></button>)}</div>
        <div className="row">
          {riskLabel && <button className="btn btn-sm btn-quiet" onClick={() => set('risk', null)}>Risk: {riskLabel} ✕</button>}
          <label><span className="sr-only">Requested by</span><select className="input" style={{ padding: '7px 12px', width: 'auto' }} value={who} onChange={(e) => set('who', e.target.value)}><option value="ALL">Agents and people</option><option value="AGENT">AI agents only</option><option value="HUMAN">People only</option></select></label>
        </div>
      </div>
      {list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data ? <Loading /> :
        <Activity rows={shown} empty={rows.length ? <p>No transactions match these filters.</p> : <><h3>No payment requests yet</h3><p>Upload an invoice, or use Security Testing to send genuine and malicious requests.</p></>} />}
    </div>
  );
}

export function NewRequest({ onDone, onCancel }: { onDone: (id: string) => void; onCancel: () => void }) {
  const vendors = useLoad<any>('/api/vendors');
  const [files, setFiles] = useState<File[]>([]);
  const [vendorId, setVendorId] = useState('');
  const [category, setCategory] = useState('hosting');
  const [manual, setManual] = useState(false);
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true); setError(null);
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    if (vendorId) form.append('vendor_id', vendorId);
    form.append('category', category);
    if (manual) {
      const m = toMinor(amount);
      if (m === null) { setError('Enter the amount as a number, for example 1296.00.'); setBusy(false); return; }
      form.append('amount_minor', String(m)); form.append('currency', 'USD');
      if (dest) { form.append('destination_type', 'PAYPAL_EMAIL'); form.append('destination_value', dest); }
    }
    try { const r = await api.post<{ id: string }>('/api/payment-requests', form); onDone(r.id); }
    catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <section className="panel" aria-label="Upload an invoice">
      <div className="panel-head"><h2 className="h3">Upload an invoice</h2><span className="muted small">Files are treated as untrusted. Instructions inside them are ignored.</span></div>
      <div className="grid-2">
        <Dropzone files={files} setFiles={setFiles} />
        <div className="stack-sm">
          <label className="field">Vendor<span className="hint">Optional. Leave blank to let PayeeProof match the invoice.</span>
            <select className="input" value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Match automatically</option>{vendors.data?.vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="field">Category<select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>{['hosting', 'software', 'office', 'legal', 'design', 'travel', 'other'].map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} /> Enter the amount myself</label>
          {manual && <div className="form-grid">
            <label className="field">Amount in USD<input className="input" inputMode="decimal" placeholder="1296.00" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
            <label className="field">Pay to PayPal account<span className="hint">Optional</span><input className="input" type="email" value={dest} onChange={(e) => setDest(e.target.value)} /></label>
          </div>}
        </div>
      </div>
      {error && <div className="notice error" style={{ marginTop: 16 }} role="alert">{error}</div>}
      <div className="row" style={{ marginTop: 18 }}>
        <button className="btn btn-primary" onClick={submit} disabled={busy || (!files.length && !manual)}>{busy ? 'Investigating…' : 'Investigate'}</button>
        <button className="btn btn-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
        {busy && <span className="muted small">Reading the files, checking your records and applying policy. Images take longer.</span>}
      </div>
    </section>
  );
}
