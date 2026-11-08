import { useSearchParams } from 'react-router-dom';
import { when } from '../api';
import { Chip, ErrorNote, Loading, useLoad } from '../ui';
import { Audit } from './Audit';

export function Settings() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'audit' ? 'audit' : 'integrations';
  return (
    <div className="stack">
      <div className="page-head"><div><h1 className="h1">Settings</h1><p className="lead">What this server is connected to, and the tamper-evident record of everything that happened.</p></div></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'integrations'} onClick={() => setParams({}, { replace: true })}>Integrations</button>
        <button role="tab" aria-selected={tab === 'audit'} onClick={() => setParams({ tab: 'audit' }, { replace: true })}>Audit ledger</button>
      </div>
      {tab === 'audit' ? <Audit /> : <Integrations />}
    </div>
  );
}

function Integrations() {
  const { data, error, reload } = useLoad<any>('/api/integrations');
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!data) return <Loading lines={5} />;
  const p = data.paypal;
  return (
    <div className="stack">
      <p className="small muted">Credentials stay on the server, inside the payment executor. Browser code, AI models and agents never receive them.</p>
      <div className="grid-2">
        <section className="panel"><div className="panel-head"><h2 className="h3">PayPal sandbox</h2><Chip tone={p.reachable ? 'ALLOW' : p.configured ? 'DENY' : 'HOLD'}>{p.reachable ? 'Connected' : p.configured ? 'Unreachable' : 'Not configured'}</Chip></div>
          <dl className="kv"><dt>Environment</dt><dd>{p.environment}. The executor refuses live PayPal URLs.</dd><dt>Payment rails</dt><dd>Payouts API, and Orders API with buyer approval</dd><dt>Confirmation</dt><dd>Authenticated API lookup{p.webhook ? ' and verified webhooks' : ''}</dd>
            <dt>Webhooks</dt><dd>{p.webhook ? 'Verified with PayPal’s signature verification API' : 'No webhook ID configured, so every webhook is rejected'}</dd><dt>Webhook URL</dt><dd className="hash">{p.webhookUrl}</dd>{p.error && <><dt>Error</dt><dd>{p.error}</dd></>}</dl></section>
        <section className="panel"><div className="panel-head"><h2 className="h3">AI model</h2><Chip tone={data.model.configured ? 'ALLOW' : 'HOLD'}>{data.model.configured ? data.model.name : 'Not configured'}</Chip></div>
          <p className="small">{data.model.configured ? 'Claude reads invoices alongside the deterministic parser and writes investigator notes. Its output can raise a decision to review. It has no tools, no credentials and no path to the executor.' : 'Without a model key, extraction is deterministic: a PDF text layer, local OCR for images, and email parsing. Decisions work the same way.'}</p>
          <p className="small muted" style={{ marginTop: 10 }}>Local OCR runs on this server with bundled language data. Files are not sent to a third party unless a model is configured.</p></section>
        <section className="panel"><h2 className="h3">Public evidence</h2><p className="small">{data.publicEvidence ? 'On. DNS, DMARC and RDAP registration lookups for sender domains, plus a size-limited fetch of the vendor homepage, scanned as untrusted text. Corroboration only: these never verify a payee.' : 'Off on this server.'}</p></section>
        <section className="panel"><h2 className="h3">Agent endpoint</h2><p className="hash">{data.agentEndpoint}</p><p className="small muted" style={{ marginTop: 8 }}>Signed Ed25519 requests only. Agents receive decisions, never credentials.</p></section>
      </div>
      <section className="panel"><h2 className="h3">Recent PayPal events</h2>
        {data.recentProviderEvents.length ? data.recentProviderEvents.map((e: any, i: number) => <p key={i} className="small">{e.event_type} <Chip tone={e.verified ? 'ALLOW' : 'DENY'}>{e.verified ? 'verified' : 'rejected'}</Chip> <span className="muted">{when(e.received_at)}</span></p>) : <p className="muted small">No webhook events have been received for this workspace.</p>}</section>
      <p className="disclaimer">PayeeProof is an independent hackathon project. It is not affiliated with, endorsed by or certified by PayPal. PayPal is a trademark of PayPal, Inc., used here only to identify the sandbox integration.</p>
    </div>
  );
}
