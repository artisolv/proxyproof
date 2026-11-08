import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, toMinor, when } from '../api';
import { can, useMe } from '../main';
import { ErrorNote, Loading, useLoad, useToast } from '../ui';

export function Policy() {
  const { me } = useMe();
  const toast = useToast();
  const policy = useLoad<any>('/api/policy');
  const approvals = useLoad<any>('/api/approvals');
  const [r, setR] = useState<any>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (policy.data) setR({ ...policy.data.rules, hard: (policy.data.rules.hardLimitMinor / 100).toFixed(2), threshold: (policy.data.rules.approvalThresholdMinor / 100).toFixed(2) }); }, [policy.data]);
  const owner = can(me.user?.role, ['OWNER']);
  if (policy.error) return <ErrorNote error={policy.error} retry={policy.reload} />;
  if (!policy.data || !r) return <Loading lines={6} />;
  const save = async () => {
    setError(null);
    const { hard, threshold, ...rules } = r;
    const h = toMinor(hard), t = toMinor(threshold);
    if (h === null || t === null) { setError('Enter limits as numbers, for example 25000.00.'); return; }
    try { const out = await api.put('/api/policy', { rules: { ...rules, hardLimitMinor: h, approvalThresholdMinor: t, unusualAmountMultiple: Number(rules.unusualAmountMultiple), decisionTtlMinutes: Number(rules.decisionTtlMinutes) }, note: note || undefined }); toast(`Policy version ${out.version} is now active.`); setNote(''); policy.reload(); }
    catch (e: any) { setError(e.message); }
  };
  const sel = (k: string, opts: [string, string][]) => <select className="input" disabled={!owner} value={r[k]} onChange={(e) => setR({ ...r, [k]: e.target.value })}>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
  const box = (k: string, label: string) => <label className="check"><input type="checkbox" disabled={!owner} checked={r[k]} onChange={(e) => setR({ ...r, [k]: e.target.checked })} />{label}</label>;
  return (
    <div className="stack">
      <div className="page-head"><div><h1 className="h1">Policies & approvals</h1><p className="lead">The policy engine is plain code with {policy.data.ruleCount} rules. Some are fixed hard stops. The ones below are yours to tune. Each save creates a new version, and old approvals stop applying.</p></div></div>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2 className="h3">Active policy, version {policy.data.version}</h2>{!owner && <span className="small muted">Only an owner can change the policy.</span>}</div>
          <div className="stack-sm">
            <div className="form-grid">
              <label className="field">Hard limit per payment, USD<span className="hint">Above this, payments are denied.</span><input className="input" disabled={!owner} value={r.hard} onChange={(e) => setR({ ...r, hard: e.target.value })} /></label>
              <label className="field">Approval needed above, USD<input className="input" disabled={!owner} value={r.threshold} onChange={(e) => setR({ ...r, threshold: e.target.value })} /></label>
              <label className="field">Unusual amount multiple<span className="hint">Times the vendor’s largest earlier invoice. 0 turns it off.</span><input className="input" type="number" min={0} disabled={!owner} value={r.unusualAmountMultiple} onChange={(e) => setR({ ...r, unusualAmountMultiple: e.target.value })} /></label>
              <label className="field">Decisions valid for, minutes<input className="input" type="number" min={1} disabled={!owner} value={r.decisionTtlMinutes} onChange={(e) => setR({ ...r, decisionTtlMinutes: e.target.value })} /></label>
              <label className="field">Unverified or pending vendor{sel('newVendorAction', [['HOLD', 'Hold'], ['REVIEW', 'Send for review']])}</label>
              <label className="field">Lookalike sender domain{sel('lookalikeAction', [['HOLD', 'Hold'], ['DENY', 'Deny']])}</label>
              <label className="field">Instructions aimed at software{sel('injectionAction', [['REVIEW', 'Send for review'], ['HOLD', 'Hold']])}</label>
              <label className="field">Pressure or secrecy wording{sel('urgencyAction', [['REVIEW', 'Send for review'], ['IGNORE', 'Record only']])}</label>
            </div>
            {box('requirePurchaseOrder', 'Require a purchase order')}
            {box('requireEvidenceService', 'Hold when a required verification service is unavailable')}
            {box('separationOfDuties', 'The person who submits a request cannot approve it')}
            <label className="field">Allowed currencies<input className="input" disabled={!owner} value={r.allowedCurrencies.join(', ')} onChange={(e) => setR({ ...r, allowedCurrencies: e.target.value.split(',').map((s: string) => s.trim().toUpperCase()).filter(Boolean) })} /></label>
            {owner && <><label className="field">What changed<span className="hint">Saved with the version.</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
              {error && <div className="notice error">{error}</div>}<div className="row"><button className="btn btn-primary" onClick={save}>Save as version {policy.data.version + 1}</button></div></>}
          </div>
        </section>
        <div className="stack">
          <section className="panel panel-mist"><h2 className="h3">Always enforced</h2>
            <p className="small">These cannot be turned off: unregistered, revoked or unsigned agents; forged, expired or out-of-scope authorizations; replays; payments already made; destinations that do not match verified records; conflicting or unreadable critical fields; and changes after approval.</p></section>
          <section className="panel"><h2 className="h3">Versions</h2>{policy.data.history.map((v: any) => <p key={v.version} className="small" style={{ marginBottom: 8 }}><strong>Version {v.version}</strong> · {when(v.created_at)}<br /><span className="muted">{v.note ?? 'No note'}</span></p>)}</section>
        </div>
      </div>
      <section className="panel">
        <div className="panel-head"><h2 className="h3">Waiting for approval</h2><span className="small muted">Approvals bind to one exact transaction</span></div>
        {approvals.error ? <ErrorNote error={approvals.error} /> : !approvals.data ? <Loading /> : approvals.data.open.length === 0 ? <p className="muted">Nothing is waiting for approval.</p> : (
          <div className="table-wrap"><table><thead><tr><th>Payee</th><th className="num">Amount</th><th>Why</th><th></th></tr></thead><tbody>{approvals.data.open.map((a: any) => <tr key={a.id}><td>{a.vendor_name ?? a.payee_name}</td><td className="num">{money(a.amount_minor, a.currency ?? 'USD')}</td><td className="small">{a.reasons.map((x: any) => x.message).join(' ')}</td><td><Link className="btn btn-sm btn-secondary" to={`/app/transactions/${a.payment_request_id}`}>Review</Link></td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}
