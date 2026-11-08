import { Link } from 'react-router-dom';
import { when } from '../api';
import { Chip, ErrorNote, Loading, useLoad } from '../ui';

export function Audit() {
  const { data, error, reload } = useLoad<any>('/api/audit');
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data) return <Loading lines={6} />;
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}><p className="small muted" style={{ maxWidth: '70ch' }}>Every event is chained to the one before it with SHA-256. The database refuses edits and deletions, and the chain shows any change made around that.</p>
        <button className="btn btn-sm btn-secondary" onClick={reload}>Verify the chain again</button></div>
      <div className={`notice ${data.chain.ok ? 'ok' : 'error'}`} role="status"><strong>{data.chain.ok ? `The chain is intact: ${data.chain.events} events verified.` : `The chain is broken at event ${data.chain.brokenAtSeq}.`}</strong>{data.chain.head && <div className="hash" style={{ marginTop: 4 }}>Head {data.chain.head}</div>}</div>
      <div className="grid-2">
        <section className="panel"><h2 className="h3">Events</h2>
          <ol className="timeline">{data.events.map((e: any) => <li key={e.seq}><span className="n">{e.seq}</span><div>
            <div className="t">{e.event_type.toLowerCase().replace(/_/g, ' ').replace(/^./, (x: string) => x.toUpperCase())} {e.payment_request_id && <Link className="small" to={`/app/transactions/${e.payment_request_id}`}>Open request</Link>}</div>
            <div className="small muted">{e.actor_type.toLowerCase()} · {when(e.created_at)}</div>
            <details><summary className="small">Details</summary><pre className="hash" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(e.payload, null, 2)}</pre><div className="hash">prev {e.prev_hash}</div></details>
            <div className="hash">{e.hash}</div></div></li>)}</ol>
        </section>
        <section className="panel"><h2 className="h3">Payment gate</h2>
          <p className="small muted" style={{ marginBottom: 12 }}>Every attempt to release a payment, and what the gate said.</p>
          {data.gate.length ? data.gate.map((g: any, i: number) => <div key={i} className="ev"><div className="ev-top"><span className="ev-claim">{g.reason_code.toLowerCase().replace(/_/g, ' ')}</span><Chip tone={g.outcome === 'PASSED' ? 'ALLOW' : 'DENY'}>{g.outcome === 'PASSED' ? 'Passed' : 'Refused'}</Chip></div><div className="ev-meta"><span>{g.detail}</span><span>{when(g.created_at)}</span>{g.payment_request_id && <Link to={`/app/transactions/${g.payment_request_id}`}>Request</Link>}</div></div>) : <p className="muted">No release attempts yet.</p>}
        </section>
      </div>
    </div>
  );
}
