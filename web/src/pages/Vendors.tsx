import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, when } from '../api';
import { can, useMe } from '../main';
import { Chip, ErrorNote, Loading, Modal, useLoad, useToast } from '../ui';

const DEST_WORD: Record<string, string> = { PAYPAL_EMAIL: 'PayPal', IBAN: 'IBAN', BANK_ACCOUNT: 'Bank account' };
export function Payees() {
  const { me } = useMe();
  const [params] = useSearchParams();
  const { data, error, reload } = useLoad<any>('/api/vendors');
  const dash = useLoad<any>('/api/dashboard');
  const changes = dash.data?.payees.destChanges ?? [];
  const unknown = dash.data?.payees.unknownPayees ?? [];
  const [adding, setAdding] = useState(params.get('new') === '1');
  const [verifying, setVerifying] = useState<any>(null);
  const write = can(me.user?.role, ['OWNER', 'FINANCE_ADMIN']);
  const toast = useToast();
  const setStatus = async (v: any, status: string) => { try { await api.post(`/api/vendors/${v.id}/status`, { status }); toast(`${v.name} is now ${status.toLowerCase()}.`); reload(); } catch (e: any) { toast(e.message); } };
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1 className="h1">Payees</h1><p className="lead">Two things are verified separately: who the business is, and where its money goes. A known vendor asking to be paid somewhere new is held until that destination is confirmed through a channel you already trust.</p></div>
        {write && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add a payee</button>}
      </div>
      {(changes.length > 0 || unknown.length > 0) && <section className="panel" style={{ borderColor: 'var(--hold-bg)', background: '#fffaf2' }}>
        <h2 className="h3">Waiting for independent verification</h2>
        <div className="grid-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <div>{changes.length ? changes.map((x: any) => <div key={x.requestId} className="swap"><strong>{x.payee} asked to be paid somewhere new</strong><span className="from">Verified on file: {x.onFile.join(', ') || 'nothing'}</span><span className="to">Requested: {x.requested}</span><Link className="small" to={`/app/transactions/${x.requestId}`}>Open the held request</Link></div>) : <p className="small muted">No destination change requests.</p>}</div>
          <div>{unknown.length ? unknown.map((x: any) => <div key={x.payee} className="swap"><strong>{x.payee}</strong><span className="muted">Not in your directory. Payments are held until someone verifies who they are and where to pay them.</span><Link className="small" to={`/app/transactions/${x.requestId}`}>Open the request</Link></div>) : <p className="small muted">No unknown payees.</p>}</div>
        </div>
      </section>}
      {error ? <ErrorNote error={error} retry={reload} /> : !data ? <Loading /> : data.vendors.length === 0 ? <div className="panel empty"><h3>No payees yet</h3><p>Add the suppliers you pay, with destinations you confirmed yourself.</p></div> : (
        <div className="stack-sm">{data.vendors.map((v: any) => (
          <section className="panel" key={v.id}>
            <div className="panel-head"><h2 className="h3">{v.name}</h2><div className="row">
              {write && v.status !== 'VERIFIED' && v.status !== 'REVOKED' && <button className="btn btn-sm btn-primary" onClick={() => setVerifying(v)}>Verify</button>}
              {write && v.status === 'VERIFIED' && <><button className="btn btn-sm btn-quiet" onClick={() => setVerifying(v)}>Add destination</button><button className="btn btn-sm btn-quiet" onClick={() => setStatus(v, 'SUSPENDED')}>Suspend</button></>}
              {write && v.status !== 'REVOKED' && <button className="btn btn-sm btn-danger" onClick={() => setStatus(v, 'REVOKED')}>Revoke</button>}</div></div>
            <div className="grid-3">
              <div><div className="small" style={{ fontWeight: 700, marginBottom: 8 }}>Business identity <Chip tone={v.status}>{v.status === 'VERIFIED' ? 'verified' : v.status.toLowerCase()}</Chip></div>
                <dl className="kv"><dt>Email domains</dt><dd>{v.domains.join(', ') || 'None'}</dd><dt>Country</dt><dd>{v.country ?? 'Unknown'}</dd><dt>Business ID</dt><dd>{v.business_id ?? 'None'}</dd><dt>May bill for</dt><dd>{v.categories.join(', ') || 'Any category'}</dd></dl></div>
              <div><div className="small" style={{ fontWeight: 700, marginBottom: 8 }}>Payment destinations <Chip tone={v.destinations.some((d: any) => d.status === 'VERIFIED') ? 'VERIFIED' : 'HOLD'}>{v.destinations.filter((d: any) => d.status === 'VERIFIED').length} verified</Chip></div>
                {v.destinations.length ? v.destinations.map((d: any) => <div key={d.id} style={{ marginBottom: 8 }}><strong>{DEST_WORD[d.type]}</strong> <span style={{ overflowWrap: 'anywhere' }}>{d.value}</span><div className="tiny muted">{d.verification_method}, {when(d.verified_at)}</div></div>) : <p className="muted small">None verified. Every payment to this payee is held.</p>}
                {changes.filter((x: any) => x.payee === v.name).map((x: any) => <div key={x.requestId} className="tiny" style={{ color: 'var(--hold)', fontWeight: 650 }}>Requested, not verified: {x.requested}</div>)}</div>
              <div><div className="small" style={{ fontWeight: 700, marginBottom: 8 }}>Verification history</div>{v.verifications.slice(0, 3).map((x: any, i: number) => <p key={i} className="small" style={{ marginBottom: 6 }}>{x.kind.toLowerCase()}: {x.method} <span className="muted tiny">{when(x.created_at)}</span></p>)}<p className="small muted">{v.invoices} invoice(s) on record</p></div>
            </div>
          </section>))}</div>
      )}
      {adding && <AddVendor onClose={() => setAdding(false)} onDone={(v) => { setAdding(false); reload(); setVerifying(v); }} />}
      {verifying && <VerifyVendor vendor={verifying} onClose={() => setVerifying(null)} onDone={() => { setVerifying(null); reload(); }} />}
    </div>
  );
}

function AddVendor({ onClose, onDone }: { onClose: () => void; onDone: (v: any) => void }) {
  const [params] = useSearchParams();
  const [f, setF] = useState({ name: params.get('name') ?? '', domain: '', country: '', businessId: '', categories: '' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      const r = await api.post('/api/vendors', { name: f.name, domains: f.domain ? [f.domain.trim()] : [], country: f.country || undefined, businessId: f.businessId || undefined, categories: f.categories ? f.categories.split(',').map((s) => s.trim()).filter(Boolean) : [] });
      onDone({ id: r.id, name: f.name, prefill: params.get('dest') ?? '', request: params.get('request') });
    } catch (err: any) { setError(err.message); }
  };
  return <Modal title="Add a payee" onClose={onClose}><form className="stack-sm" onSubmit={submit} style={{ marginTop: 12 }}>
    <p className="small muted">New payees start as pending. Payments to them are held until you verify their identity and a destination.</p>
    <label className="field">Legal name<input className="input" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
    <div className="form-grid"><label className="field">Email domain<input className="input" placeholder="vendor.com" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} /></label>
      <label className="field">Country<input className="input" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })} /></label></div>
    <div className="form-grid"><label className="field">Business ID<input className="input" value={f.businessId} onChange={(e) => setF({ ...f, businessId: e.target.value })} /></label>
      <label className="field">Categories<span className="hint">Comma separated</span><input className="input" value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} /></label></div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="row"><button className="btn btn-primary">Add payee</button></div>
  </form></Modal>;
}

function VerifyVendor({ vendor, onClose, onDone }: { vendor: any; onClose: () => void; onDone: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [type, setType] = useState('PAYPAL_EMAIL');
  const [value, setValue] = useState(vendor.prefill ?? '');
  const [method, setMethod] = useState('');
  const [ok, setOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      await api.post(`/api/vendors/${vendor.id}/verify`, { method, destination: { type, value } });
      if (vendor.request) { await api.post(`/api/payment-requests/${vendor.request}/analyze`); toast('Vendor verified. The request was evaluated again.'); nav(`/app/transactions/${vendor.request}`); return; }
      toast(`${vendor.name} is verified.`); onDone();
    } catch (err: any) { setError(err.message); }
  };
  return <Modal title={`Verify ${vendor.name}`} onClose={onClose}><form className="stack-sm" onSubmit={submit} style={{ marginTop: 12 }}>
    <div className="notice warn">Confirm the destination with the vendor through a channel you already trusted. Do not use details from the invoice or email you are checking.</div>
    <div className="form-grid"><label className="field">Destination type<select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="PAYPAL_EMAIL">PayPal account</option><option value="IBAN">IBAN</option><option value="BANK_ACCOUNT">Bank account</option></select></label>
      <label className="field">Destination<input className="input" required value={value} onChange={(e) => setValue(e.target.value)} /></label></div>
    <label className="field">How you confirmed it<input className="input" required minLength={8} value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Video call with the founder; matched the W-9 on file" /></label>
    <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> I confirmed this independently of any invoice or email.</label>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="row"><button className="btn btn-primary" disabled={!ok}>Verify vendor</button></div>
  </form></Modal>;
}
