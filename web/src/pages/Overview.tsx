import { Link } from 'react-router-dom';
import { money, when } from '../api';
import { Activity, ErrorNote, Loading, OUTCOME, useLoad } from '../ui';

const BAND: [string, string, string][] = [
  ['ALLOWED', 'Allowed', 'Policy permits; awaiting release'],
  ['UNDER_REVIEW', 'Under review', 'Needs a person’s decision'],
  ['HELD', 'Held', 'Blocked until verified'],
  ['DENIED', 'Denied', 'Breaks a rule; cannot be paid'],
  ['COMPLETED', 'Completed', 'Confirmed by PayPal'],
];

export function Overview() {
  const { data, error, reload } = useLoad<any>('/api/dashboard');
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data) return <Loading lines={6} />;
  const c = data.counts;
  const total = data.total || 1;
  const p = data.payees;
  const processing = c.PROCESSING + c.FAILED;
  const amountFor = (k: string) => ({ ALLOWED: data.amounts.awaitingReleaseMinor, UNDER_REVIEW: data.amounts.reviewMinor, COMPLETED: data.amounts.paidMinor } as Record<string, number>)[k] ?? 0;
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="h1">Payment security overview</h1>
          <p className="lead">Before an AI agent or a person can pay, PayeeProof verifies the payee, investigates the request, checks authorization and enforces a decision. Only allowed requests can reach PayPal.</p>
        </div>
        <div className="row"><Link className="btn btn-primary" to="/app/security-testing">Test a payment</Link><Link className="btn btn-secondary" to="/app/transactions?new=1">Upload an invoice</Link></div>
      </div>

      <div className="flow" aria-label="How every payment request is handled">
        <div><strong>Request</strong>From a person or a signed agent</div>
        <div><strong>Investigate</strong>Invoice, sender, history, duplicates</div>
        <div><strong>Verify</strong>Payee identity, destination, authority</div>
        <div><strong>Decide and gate</strong>Deterministic policy; one gate to PayPal</div>
        <div><strong>Confirm</strong>Paid only when PayPal confirms</div>
      </div>

      <section className="band" aria-label="Transaction status summary">
        <div className="band-bar" aria-hidden="true">{[...BAND.map(([k]) => k), 'PROCESSING', 'FAILED'].map((k) => c[k] ? <span key={k} style={{ flexGrow: c[k], background: OUTCOME[k].color }} /> : null)}</div>
        <div className="band-cells">
          <Link className="band-cell" to="/app/transactions"><span className="k">Payment requests</span><span className="v">{data.total}</span><span className="s">{data.passedPolicy} passed policy{processing ? `, ${processing} released` : ''}</span></Link>
          {BAND.map(([k, label, sub]) => (
            <Link key={k} className="band-cell" to={`/app/transactions?status=${k}`}>
              <span className="k"><i style={{ background: OUTCOME[k].color }} />{label}</span>
              <span className="v">{c[k]}</span>
              <span className="s">{sub}{amountFor(k) ? `, ${money(amountFor(k))}` : ''}</span>
            </Link>
          ))}
        </div>
        <div className="band-foot">
          <span><strong>{money(data.amounts.stoppedMinor)}</strong> held or denied before payment</span>
          <span><strong>{money(data.amounts.paidMinor)}</strong> paid, confirmed by PayPal</span>
          <span><strong>{data.gate.refused}</strong> release attempt{data.gate.refused === 1 ? '' : 's'} refused by the gate</span>
          <span>Audit chain <strong>{data.chain.ok ? 'intact' : 'broken'}</strong>, {data.chain.events} events</span>
        </div>
      </section>

      <div className="dash">
        <section aria-labelledby="activity-h">
          <div className="section-head"><h2 id="activity-h">Transaction activity</h2><Link className="small" to="/app/transactions">All {data.total} transactions</Link></div>
          <Activity rows={data.activity} empty={<><h3>No payment requests yet</h3><p>Upload an invoice or send an agent request to see how it is checked.</p><Link className="btn btn-primary" to="/app/security-testing">Test a payment</Link></>} />
          {c.COMPLETED === 0 && c.ALLOWED > 0 && <p className="small muted" style={{ marginTop: 10 }}>Nothing is marked completed until PayPal confirms it. Open an allowed request and release it to make a real sandbox payment.</p>}
        </section>

        <div>
          <section className="mini" aria-labelledby="payee-h">
            <h2 id="payee-h">Payee verification</h2>
            <p className="sub">A verified business is not the same as a verified payment destination. Each new destination is checked on its own.</p>
            <div className="pair">
              <div><div className="v">{p.verified}</div><div className="l">Verified businesses{p.pending ? `, ${p.pending} pending` : ''}{p.restricted ? `, ${p.restricted} suspended or revoked` : ''}</div></div>
              <div><div className="v">{p.verifiedDestinations}</div><div className="l">Verified payment destinations</div></div>
            </div>
            {p.destChanges.length > 0 && <div><div className="small" style={{ fontWeight: 650, margin: '4px 0 2px' }}>Destination change requests</div>
              {p.destChanges.map((x: any) => <Link key={x.requestId} className="swap" to={`/app/transactions/${x.requestId}`}><span style={{ fontWeight: 650 }}>{x.payee}</span><span className="from">On file: {x.onFile.join(', ') || 'nothing verified'}</span><span className="to">Requested: {x.requested}</span></Link>)}</div>}
            {p.unknownPayees.length > 0 && <div style={{ marginTop: 6 }}><div className="small" style={{ fontWeight: 650, margin: '4px 0 2px' }}>Need independent verification</div>
              {p.unknownPayees.map((x: any) => <Link key={x.payee} className="line-item" to={`/app/transactions/${x.requestId}`}><span className="li-t">{x.payee}</span><span className="tag">Not in directory</span></Link>)}</div>}
            {p.recentDestinations.length > 0 && <div style={{ marginTop: 6 }}><div className="small" style={{ fontWeight: 650, margin: '4px 0 2px' }}>Recently verified destinations</div>
              {p.recentDestinations.map((x: any, i: number) => <div key={i} className="line-item"><span className="li-t">{x.payee}<div className="tiny muted">{x.value}</div></span><span className="tiny muted">{when(x.verifiedAt)}</span></div>)}</div>}
            <Link className="small" to="/app/payees" style={{ display: 'inline-block', marginTop: 10 }}>Manage payees</Link>
          </section>

          <section className="mini" aria-labelledby="ins-h">
            <h2 id="ins-h">Security insights</h2>
            <p className="sub">Risks found in requests that are currently stopped. Counted from recorded policy decisions.</p>
            {data.insights.length ? data.insights.map((i: any) => (
              <Link key={i.key} className="line-item" to={`/app/transactions?risk=${i.key}`}><span className="li-t">{i.label}<div className="tiny muted">{money(i.amountMinor)} at stake</div></span><span className="li-n">{i.count}</span></Link>
            )) : <p className="small muted">No open risks.</p>}
          </section>

          <section className="mini" aria-labelledby="agent-h">
            <h2 id="agent-h">AI agents</h2>
            <p className="sub">Agents can request payments. They cannot approve or release them.</p>
            {data.agents.map((a: any) => <Link key={a.id} className="line-item" to="/app/agents"><span className="li-t">{a.name}<div className="tiny muted">{a.requests} request{a.requests === 1 ? '' : 's'}, {a.denied} denied</div></span><span className={`tag`}>{a.status.toLowerCase()}</span></Link>)}
            {data.unregisteredAgentRequests > 0 && <div className="line-item"><span className="li-t">Unregistered agents</span><span className="li-n">{data.unregisteredAgentRequests}</span></div>}
          </section>
        </div>
      </div>
    </div>
  );
}
