import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, toMinor } from '../api';
import { can, useMe } from '../main';
import { Checklist, Chip, Dropzone, ErrorNote, Loading, OutcomeChip, useLoad, useToast } from '../ui';

/** Test files the server generates on request. The names describe the file, not the verdict, which is computed. */
const FILES: [string, string, string][] = [
  ['genuine-northwind-invoice.pdf', 'Genuine invoice', 'Known vendor, verified PayPal destination'],
  ['tampered-destination-invoice.pdf', 'Changed destination', 'Same invoice, new PayPal recipient'],
  ['wrong-total-invoice.pdf', 'Wrong total', 'Printed total does not add up'],
  ['prompt-injection-invoice.pdf', 'Prompt injection', 'Text telling AI reviewers to approve'],
  ['lookalike-sender-email.eml', 'Lookalike sender', 'Email from a one-letter-off domain'],
  ['genuine-email-with-invoice.eml', 'Genuine email', 'Verified domain, passing authentication'],
  ['new-vendor-invoice.pdf', 'New vendor', 'A payee nobody has verified'],
  ['large-legal-invoice.pdf', 'Unusually large bill', 'Verified law firm, far above history'],
];

type Preset = { key: string; title: string; desc: string; vendor: 'northwind' | 'meridian'; amount: string; category: string; destination?: 'attacker'; tamper: string };
const AGENT_PRESETS: Preset[] = [
  { key: 'legit', title: 'Legitimate request', desc: 'Authorized vendor, within limits, verified destination', vendor: 'northwind', amount: '742.50', category: 'hosting', tamper: 'none' },
  { key: 'limit', title: 'Exceed the per-payment limit', desc: '$3,000 against a $2,500 limit', vendor: 'northwind', amount: '3000.00', category: 'hosting', tamper: 'none' },
  { key: 'vendor', title: 'Pay an unapproved vendor', desc: 'Meridian is trusted, but not in this agent’s scope', vendor: 'meridian', amount: '340.00', category: 'office', tamper: 'none' },
  { key: 'category', title: 'Outside its category', desc: 'Travel, when it may only buy hosting and software', vendor: 'northwind', amount: '450.00', category: 'travel', tamper: 'none' },
  { key: 'dest', title: 'Redirect the money', desc: 'Right vendor, new PayPal recipient', vendor: 'northwind', amount: '1296.00', category: 'hosting', destination: 'attacker', tamper: 'none' },
  { key: 'sig', title: 'Forged signature', desc: 'Signed with a key the agent never registered', vendor: 'northwind', amount: '1296.00', category: 'hosting', tamper: 'forged_signature' },
  { key: 'auth', title: 'Self-made authorization', desc: 'Claims a $999,999 limit nobody issued', vendor: 'northwind', amount: '1296.00', category: 'hosting', tamper: 'forged_authorization' },
  { key: 'replay', title: 'Replay a signed request', desc: 'The same signed request, sent twice', vendor: 'northwind', amount: '1296.00', category: 'hosting', tamper: 'replay' },
  { key: 'stale', title: 'Stale request', desc: 'Signed an hour ago', vendor: 'northwind', amount: '1296.00', category: 'hosting', tamper: 'stale_timestamp' },
];
const TAMPER_WORD: Record<string, string> = { none: 'None', forged_signature: 'Signed with an unregistered key', forged_authorization: 'Self-made authorization', no_authorization: 'No authorization', stale_timestamp: 'Timestamp an hour old', replay: 'Sent twice with the same nonce' };
const ATTACKER = 'northwind-billing@payments-desk.example';

const GROUP: Record<string, string> = { LEGITIMATE: 'Legitimate payment', FRAUD: 'Malicious invoice', HARD_STOP: 'Authorization and replay', INJECTION: 'Prompt injection', BYPASS: 'Gate bypass', WEBHOOK: 'Provider events', PROVIDER: 'Real sandbox payment' };

export function SecurityTesting() {
  const { me } = useMe();
  const toast = useToast();
  const { data, error, reload } = useLoad<any>('/api/challenge');
  const [running, setRunning] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<any>(null);
  const runner = can(me.user?.role, ['OWNER', 'FINANCE_ADMIN', 'REVIEWER']);
  const runAll = async (body: any, label: string) => {
    setRunning(label); setRunError(null);
    try { const r = await api.post('/api/challenge/run', { ...body, batchId: body.scenarios ? data?.batchId ?? undefined : undefined }); toast(`${r.score.passed} of ${r.score.total} scenarios behaved as published.`); await reload(); }
    catch (e: any) { setRunError(e.message); } finally { setRunning(null); }
  };
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data) return <Loading lines={6} />;
  const byId = Object.fromEntries((data.runs ?? []).map((r: any) => [r.scenario_id, r]));
  const s = data.score;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1 className="h1">Security Testing</h1><p className="lead">Send genuine and malicious payment requests and watch what PayeeProof does. Everything here goes through the same extraction, evidence, policy and payment gate as real requests. Verdicts are never keyed to file names or scenario IDs.</p></div>
      </div>

      {runner ? <div className="lab">
        <Composer onResult={(id, sub) => { setResultId(id); setSubmitted(sub); }} />
        <div>{resultId ? <Result id={resultId} submitted={submitted} /> : <div className="panel panel-mist"><h2 className="h3">The result appears here</h2><p className="small">You’ll see what was submitted, what was read from it, every check and whether it matched, the decision with its reasons, and whether the payment executor was called. For a blocked request, you can then try to force the payment through the gate.</p></div>}</div>
      </div> : <div className="notice">Your role can view results but cannot submit test requests. Switch to Morgan, Priya or Sam in the sidebar.</div>}

      <section>
        <div className="section-head"><h2>Scenario suite</h2>
          {runner && <div className="row"><button className="btn btn-primary" disabled={!!running} onClick={() => runAll({}, 'all')}>{running === 'all' ? `Running ${data.scenarios.filter((x: any) => !x.live).length} scenarios…` : 'Run all scenarios'}</button>
            <button className="btn btn-secondary" disabled={!!running} onClick={() => runAll({ scenarios: ['T18'] }, 'T18')}>{running === 'T18' ? 'Paying in the sandbox…' : 'Run a real sandbox payment'}</button></div>}
        </div>
        <p className="small muted" style={{ marginBottom: 12 }}>Each scenario runs in a fresh, isolated copy of this workspace, so results are repeatable and don’t mix with your transactions. Blocked scenarios also try to release the payment, and pass only if the gate refuses.</p>
        {runError && <div className="notice error" role="alert" style={{ marginBottom: 12 }}>{runError}</div>}
        {s && <div className="band" style={{ marginBottom: 14 }}><div className="band-cells" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
          <div className="band-cell"><span className="k">Behaved as published</span><span className="v">{s.passed}/{s.total}</span><span className="s">{s.pending ? `${s.pending} waiting for PayPal` : 'All finished'}</span></div>
          <div className="band-cell"><span className="k">Attacks stopped</span><span className="v">{s.fraudBlocked.passed}/{s.fraudBlocked.total}</span><span className="s">Held, denied or sent to review</span></div>
          <div className="band-cell"><span className="k">Legitimate payments allowed</span><span className="v">{s.legitimateAllowed.passed}/{s.legitimateAllowed.total}</span><span className="s">It does not just block everything</span></div>
          <div className="band-cell"><span className="k">False positives / negatives</span><span className="v">{s.falsePositives} / {s.falseNegatives}</span><span className="s">On these synthetic scenarios</span></div>
        </div></div>}
        <div className="table-wrap"><table>
          <thead><tr><th>Scenario</th><th>Use case</th><th>Expected</th><th>Result</th><th>Executor</th><th></th></tr></thead>
          <tbody>{data.scenarios.map((sc: any) => {
            const r = byId[sc.id];
            return <tr key={sc.id}>
              <td><strong>{sc.title}</strong> <span className="tiny muted">{sc.id}</span><div className="small muted">{sc.description}</div>{r?.details?.note && <div className="tiny muted" style={{ marginTop: 4, maxWidth: '62ch' }}>{r.details.note}</div>}</td>
              <td><span className="tag">{GROUP[sc.category]}</span></td>
              <td className="small">{sc.expected}</td>
              <td>{r ? <Chip tone={r.passed === 1 ? 'pass' : r.passed === 0 ? 'fail' : 'pending'}>{r.actual}{r.passed === 1 ? ', as expected' : r.passed === 0 ? ', unexpected' : ', waiting'}</Chip> : <span className="muted small">Not run</span>}</td>
              <td className="small">{r ? (r.executor_called ? 'Called' : 'Not called') : ''}</td>
              <td><div className="row" style={{ flexWrap: 'nowrap' }}>{r?.payment_request_id && <Link className="btn btn-sm btn-quiet" to={`/app/transactions/${r.payment_request_id}`}>Open</Link>}{runner && !sc.live && <button className="btn btn-sm btn-quiet" disabled={!!running} onClick={() => runAll({ scenarios: [sc.id] }, sc.id)}>{running === sc.id ? 'Running…' : 'Run'}</button>}</div></td>
            </tr>;
          })}</tbody>
        </table></div>
        <p className="small muted" style={{ marginTop: 12 }}>These are seeded synthetic scenarios, not independently verified real-world fraud samples. PayeeProof does not claim to catch every fraud. It fails closed: anything critical it cannot verify is held, not allowed.</p>
      </section>
    </div>
  );
}

function Composer({ onResult }: { onResult: (id: string, submitted: any) => void }) {
  const [mode, setMode] = useState<'file' | 'agent'>('file');
  return (
    <section className="panel">
      <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
        <button role="tab" aria-selected={mode === 'file'} onClick={() => setMode('file')}>Upload an invoice</button>
        <button role="tab" aria-selected={mode === 'agent'} onClick={() => setMode('agent')}>Send an agent request</button>
      </div>
      {mode === 'file' ? <FileTest onResult={onResult} /> : <AgentTest onResult={onResult} />}
    </section>
  );
}

function FileTest({ onResult }: { onResult: (id: string, submitted: any) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (name: string) => {
    setError(null);
    try {
      const res = await fetch(`/api/challenge/fixtures/${name}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('The test file could not be generated.');
      const blob = await res.blob();
      setFiles([new File([blob], name, { type: blob.type })]);
    } catch (e: any) { setError(e.message); }
  };
  const run = async () => {
    setBusy(true); setError(null);
    const form = new FormData();
    files.forEach((f) => form.append('files', f));
    form.append('category', 'hosting');
    try { const r = await api.post<{ id: string }>('/api/payment-requests', form); onResult(r.id, { kind: 'file', files: files.map((f) => f.name) }); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="stack-sm">
      <p className="small muted">Pick a test file, or drop your own invoice, email or scan. Download a test file, edit it, and upload it again to see the decision change.</p>
      <div className="presets">{FILES.map(([name, title, desc]) => <button key={name} className="preset" aria-pressed={files[0]?.name === name} onClick={() => load(name)}><span className="t">{title}</span><a className="tiny" href={`/api/challenge/fixtures/${name}`} onClick={(e) => e.stopPropagation()}>Download</a><span className="d">{desc}</span></button>)}</div>
      <Dropzone files={files} setFiles={setFiles} />
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row"><button className="btn btn-primary" disabled={busy || !files.length} onClick={run}>{busy ? 'Investigating…' : 'Run checks'}</button>{busy && <span className="small muted">Reading the file, gathering evidence, applying policy.</span>}</div>
    </div>
  );
}

function AgentTest({ onResult }: { onResult: (id: string, submitted: any) => void }) {
  const agents = useLoad<any>('/api/agents');
  const vendors = useLoad<any>('/api/vendors');
  const [preset, setPreset] = useState<Preset>(AGENT_PRESETS[0]);
  const [f, setF] = useState({ amount: preset.amount, category: preset.category, destination: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agent = agents.data?.agents.find((a: any) => a.simulated && a.status === 'ACTIVE') ?? agents.data?.agents.find((a: any) => a.simulated);
  const vid = (k: string) => vendors.data?.vendors.find((v: any) => v.name.toLowerCase().startsWith(k))?.id;
  const pick = (p: Preset) => { setPreset(p); setF({ amount: p.amount, category: p.category, destination: p.destination === 'attacker' ? ATTACKER : '' }); };
  const send = async () => {
    if (!agent) return;
    const m = toMinor(f.amount);
    if (m === null) { setError('Enter an amount like 1296.00.'); return; }
    setBusy(true); setError(null);
    const form = new FormData();
    const fields: Record<string, string> = { vendor_id: vid(preset.vendor) ?? '', amount_minor: String(m), currency: 'USD', category: f.category, tamper: preset.tamper, purpose: preset.title };
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    if (f.destination) { form.append('destination_type', 'PAYPAL_EMAIL'); form.append('destination_value', f.destination); }
    try {
      const r = await api.post(`/api/agents/${agent.id}/simulate`, form);
      onResult(r.request_id, { kind: 'agent', agent: agent.name, vendor: vendors.data?.vendors.find((v: any) => v.id === fields.vendor_id)?.name, amount_minor: m, category: f.category, destination: f.destination || 'Not stated (uses the verified one)', tamper: TAMPER_WORD[preset.tamper] });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  if (agents.error) return <ErrorNote error={agents.error} retry={agents.reload} />;
  if (!agents.data || !vendors.data) return <Loading />;
  if (!agent) return <p className="muted">This workspace has no simulator agent. Register one on the AI Agents page.</p>;
  return (
    <div className="stack-sm">
      <p className="small muted">The request is signed with {agent.name}’s Ed25519 key and posted through the same path a real external agent uses. Its authorization: Northwind only, hosting and software, up to $2,500 each.</p>
      <div className="presets">{AGENT_PRESETS.map((p) => <button key={p.key} className="preset" aria-pressed={preset.key === p.key} onClick={() => pick(p)}><span className="t">{p.title}</span><span /><span className="d">{p.desc}</span></button>)}</div>
      <div className="form-grid">
        <label className="field">Amount, USD<input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
        <label className="field">Category<input className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></label>
        <label className="field">Pay to<span className="hint">Blank uses the vendor’s verified destination</span><input className="input" value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} /></label>
      </div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="row"><button className="btn btn-primary" disabled={busy} onClick={send}>{busy ? 'Signing and sending…' : 'Sign and send'}</button></div>
    </div>
  );
}

function Result({ id, submitted }: { id: string; submitted: any }) {
  const { me } = useMe();
  const { data: c, error, reload } = useLoad<any>(`/api/payment-requests/${id}`, [id]);
  const [force, setForce] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!c) return <div className="panel"><Loading lines={6} /></div>;
  const a = c.assessment;
  const ext = c.invoice;
  const finance = can(me.user?.role, ['OWNER', 'FINANCE_ADMIN']);
  const tryPay = async () => {
    setBusy(true);
    try { const r = await api.post(`/api/payment-requests/${id}/execute`, { decision_id: c.decision?.id }); setForce({ ok: true, text: r.status === 'FAILED' ? `The gate released it. PayPal refused: ${r.failure ?? 'no reason given'}` : `The gate released it. PayPal status: ${String(r.status ?? 'sent').toLowerCase().replace('_', ' ')}${r.providerRef ? `, batch ${r.providerRef}` : ''}.` }); await reload(); }
    catch (e: any) { setForce({ ok: false, text: `${e.code ? `${e.code}: ` : ''}${e.message}` }); await reload(); } finally { setBusy(false); }
  };
  const blocked = !['ALLOWED', 'FAILED'].includes(a.outcome);
  return (
    <section className="panel stack-sm" aria-live="polite">
      <div className="result-head"><div><div className="small muted">Result</div><h2 className="h3" style={{ margin: 0 }}>{a.payee}, {money(a.amount_minor, a.currency ?? 'USD')}</h2></div><OutcomeChip o={a.outcome} /></div>
      <p style={{ fontWeight: 650, fontSize: 17, letterSpacing: '-0.015em' }}>{a.reason}</p>
      <dl className="kv small">
        <dt>Submitted</dt><dd>{submitted?.kind === 'file' ? submitted.files.join(', ') : submitted ? `${submitted.agent} asked to pay ${submitted.vendor ?? 'a vendor'} ${money(submitted.amount_minor)} for ${submitted.category}. Pay to: ${submitted.destination}. Manipulation: ${submitted.tamper}.` : '—'}</dd>
        <dt>Read from it</dt><dd>{ext ? `Invoice ${ext.number ?? 'with no number'} from ${ext.vendor_name ?? 'an unnamed vendor'}, total ${money(ext.total_minor, ext.currency ?? 'USD')}${c.destination ? `, pay to ${c.destination.value}` : ''}` : c.destination ? `Pay to ${c.destination.value}` : 'No invoice file'}</dd>
        <dt>Evidence</dt><dd>{c.evidence.length} item{c.evidence.length === 1 ? '' : 's'} from {[...new Set(c.evidence.map((e: any) => e.provenance))].length} kinds of source</dd>
        {c.signals?.injection?.length > 0 && <><dt>Ignored text</dt><dd><q>{c.signals.injection[0]}</q></dd></>}
      </dl>
      <div><div className="small" style={{ fontWeight: 700, margin: '6px 0 2px' }}>What was verified</div><Checklist checks={a.checks} /></div>
      {c.decision?.reasons.length > 0 && <div><div className="small" style={{ fontWeight: 700, margin: '6px 0 4px' }}>Rules that fired ({c.decision.reasons.length} of {c.decision.rulesChecked})</div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{c.decision.reasons.map((r: any) => <li key={r.code} className="small" style={{ marginBottom: 3 }}>{r.message} <span className="tiny muted">{r.code}, {r.effect.toLowerCase()}</span></li>)}</ul></div>}
      <div className={`gate-box ${a.outcome === 'FAILED' ? 'blocked' : a.executorCalled ? 'open' : blocked ? 'blocked' : 'idle'}`}>
        <strong>Payment executor: {a.executorCalled ? 'called' : 'not called'}.</strong>{' '}
        {a.executorCalled ? (a.outcome === 'FAILED' ? 'The gate released it, but PayPal did not complete it. Nothing is marked paid.' : `PayPal reference ${a.providerRef ?? 'pending'}. ${a.outcome === 'COMPLETED' ? 'Confirmed by PayPal.' : 'Waiting for PayPal to confirm.'}`) : blocked ? 'The gate only releases allowed requests, and re-checks the policy on live data before it does.' : 'Allowed by policy. Nothing is paid until a finance admin or owner releases it.'}
        {force && <div style={{ marginTop: 6 }}>{force.ok ? force.text : <>Forced release refused. <strong>{force.text}</strong></>}</div>}
      </div>
      <div className="row">
        {!a.executorCalled && finance && blocked && <button className="btn btn-danger" disabled={busy} onClick={tryPay}>{busy ? 'Trying…' : 'Try to force the payment'}</button>}
        {(!a.executorCalled || a.outcome === 'FAILED') && finance && !blocked && <button className="btn btn-primary" disabled={busy} onClick={tryPay}>{busy ? 'Sending to PayPal…' : a.outcome === 'FAILED' ? 'Try the payment again' : 'Release in the PayPal sandbox'}</button>}
        <Link className="btn btn-secondary" to={`/app/transactions/${id}`}>Open the full investigation</Link>
      </div>
    </section>
  );
}
