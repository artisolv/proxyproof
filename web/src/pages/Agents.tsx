import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, toMinor, when } from '../api';
import { can, useMe } from '../main';
import { Chip, ErrorNote, Loading, Modal, useLoad, useToast } from '../ui';

export function Agents() {
  const { me } = useMe();
  const toast = useToast();
  const { data, error, reload } = useLoad<any>('/api/agents');
  const vendors = useLoad<any>('/api/vendors');
  const integrations = useLoad<any>('/api/integrations');
  const [grantFor, setGrantFor] = useState<any>(null);
  const [adding, setAdding] = useState(false);
  const owner = can(me.user?.role, ['OWNER']);
  const revoke = async (a: any) => { if (!confirm(`Revoke ${a.name}? Its requests will be denied.`)) return; await api.post(`/api/agents/${a.id}/revoke`); toast(`${a.name} was revoked.`); reload(); };
  const vName = (id: string) => vendors.data?.vendors.find((v: any) => v.id === id)?.name ?? id;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1 className="h1">AI agents</h1><p className="lead">Agents can ask to pay. They cannot approve, release or see credentials. Each request must be signed by the agent’s registered key and carry a scoped authorization you issued.</p></div>
        {owner && <button className="btn btn-primary" onClick={() => setAdding(true)}>Register an agent</button>}
      </div>
      {error ? <ErrorNote error={error} retry={reload} /> : !data ? <Loading /> : (
        <div className="stack-sm">{data.agents.map((a: any) => {
          const g = a.authorizations.find((x: any) => x.status === 'ACTIVE') ?? a.authorizations[0];
          const expired = g && Date.parse(g.expires_at) < Date.now();
          return <section className="panel" key={a.id}>
            <div className="panel-head"><h2 className="h3">{a.name}</h2><div className="row"><Chip tone={a.status}>{a.status.toLowerCase()}</Chip>{a.simulated && <Chip tone="NEUTRAL" plain>Simulator key held by server</Chip>}
              {a.simulated && can(me.user?.role, ['OWNER', 'FINANCE_ADMIN', 'REVIEWER']) && <Link className="btn btn-sm btn-primary" to="/app/security-testing">Test this agent</Link>}
              {owner && a.status === 'ACTIVE' && <button className="btn btn-sm btn-quiet" onClick={() => setGrantFor(a)}>Issue authorization</button>}
              {owner && a.status === 'ACTIVE' && <button className="btn btn-sm btn-danger" onClick={() => revoke(a)}>Revoke agent</button>}</div></div>
            <div className="grid-2">
              <dl className="kv"><dt>Agent ID</dt><dd className="hash">{a.id}</dd><dt>Acts for</dt><dd>{a.principal}</dd><dt>Last seen</dt><dd>{a.last_seen_at ? when(a.last_seen_at) : 'Never'}</dd></dl>
              {g ? <dl className="kv"><dt>Authorization</dt><dd>Version {g.version} <Chip tone={expired ? 'EXPIRED' : g.status}>{expired ? 'expired' : g.status.toLowerCase()}</Chip></dd><dt>May pay</dt><dd>{g.vendor_ids.map(vName).join(', ')}</dd><dt>Categories</dt><dd>{g.categories.join(', ')}</dd><dt>Limits</dt><dd>{money(g.per_tx_max_minor)} each, {money(g.daily_budget_minor)} a day, {money(g.monthly_budget_minor)} a month</dd><dt>Expires</dt><dd>{when(g.expires_at)}</dd><dt>Bound to policy</dt><dd>Version {g.policy_version}</dd></dl> : <p className="muted">No authorization. Every request from this agent is denied.</p>}
            </div>
          </section>;
        })}</div>
      )}
      <section className="panel panel-mist">
        <h2 className="h3">Connect a real agent</h2>
        <p className="small">An external agent signs a canonical JSON envelope with its Ed25519 key and posts it here. It gets back a decision and reasons, never credentials. <code>scripts/agent-client.ts</code> in the repository is a working example.</p>
        <p className="hash" style={{ marginTop: 10 }}>POST {integrations.data?.agentEndpoint}</p>
        <p className="small muted" style={{ marginTop: 10 }}>Authorizations are PayeeProof’s own EdDSA-signed scoped grants. They are not AP2 mandates and are not issued by PayPal.</p>
      </section>
      {grantFor && <GrantForm agent={grantFor} vendors={vendors.data?.vendors ?? []} onClose={() => setGrantFor(null)} onDone={() => { setGrantFor(null); reload(); }} />}
      {adding && <AddAgent onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </div>
  );
}

function AddAgent({ onClose, onDone }: any) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); try { await api.post('/api/agents', { name, simulated: true }); onDone(); } catch (err: any) { setError(err.message); } };
  return <Modal title="Register an agent" onClose={onClose}><form className="stack-sm" onSubmit={submit} style={{ marginTop: 12 }}>
    <p className="small muted">PayeeProof creates an Ed25519 key pair. For this demo the server keeps the private key so you can send requests from the simulator. A production agent keeps its own key and registers only the public half.</p>
    <label className="field">Agent name<input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Accounts payable agent" /></label>
    {error && <div className="notice error">{error}</div>}<div className="row"><button className="btn btn-primary">Register agent</button></div>
  </form></Modal>;
}

function GrantForm({ agent, vendors, onClose, onDone }: any) {
  const [f, setF] = useState({ vendorIds: [] as string[], categories: 'hosting, software', perTx: '2500.00', daily: '5000.00', monthly: '20000.00', days: '30' });
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    const days = Number(f.days);
    try {
      await api.post(`/api/agents/${agent.id}/authorizations`, { vendorIds: f.vendorIds, categories: f.categories.split(',').map((s) => s.trim()).filter(Boolean), currencies: ['USD'], perTxMaxMinor: toMinor(f.perTx), dailyBudgetMinor: toMinor(f.daily), monthlyBudgetMinor: toMinor(f.monthly), expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() });
      onDone();
    } catch (err: any) { setError(err.message); }
  };
  return <Modal title={`Authorize ${agent.name}`} onClose={onClose}><form className="stack-sm" onSubmit={submit} style={{ marginTop: 12 }}>
    <p className="small muted">This replaces the agent’s current authorization. It is bound to the current policy version.</p>
    <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600, marginBottom: 6 }}>Vendors it may pay</legend>
      {vendors.filter((v: any) => v.status === 'VERIFIED').map((v: any) => <label className="check" key={v.id}><input type="checkbox" checked={f.vendorIds.includes(v.id)} onChange={(e) => setF({ ...f, vendorIds: e.target.checked ? [...f.vendorIds, v.id] : f.vendorIds.filter((x) => x !== v.id) })} />{v.name}</label>)}</fieldset>
    <label className="field">Categories<input className="input" value={f.categories} onChange={(e) => setF({ ...f, categories: e.target.value })} /></label>
    <div className="form-grid"><label className="field">Per payment, USD<input className="input" value={f.perTx} onChange={(e) => setF({ ...f, perTx: e.target.value })} /></label><label className="field">Per day<input className="input" value={f.daily} onChange={(e) => setF({ ...f, daily: e.target.value })} /></label><label className="field">Per month<input className="input" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} /></label><label className="field">Valid for days<input className="input" type="number" min={1} max={365} value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} /></label></div>
    {error && <div className="notice error">{error}</div>}<div className="row"><button className="btn btn-primary" disabled={!f.vendorIds.length}>Issue authorization</button></div>
  </form></Modal>;
}
