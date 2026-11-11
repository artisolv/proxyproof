import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Monogram } from '../Monogram';

type Status = 'Existing' | 'Integration' | 'Implementation' | 'Experimental' | 'Future';
const STATUS_HELP: Record<Status, string> = {
  Existing: 'Defined or provided by a named standard or product',
  Integration: 'ProxyProof verifies or connects an existing capability',
  Implementation: 'Built by ProxyProof from existing building blocks',
  Experimental: 'A ProxyProof profile or prototype, not an adopted standard',
  Future: 'Not implemented in this build',
};

const ECOSYSTEM: { name: string; status: string; covers: string; proxyproof: string }[] = [
  { name: 'Google AP2 (v0.2)', status: 'Published spec; Python SDK', covers: 'Mandates (SD-JWT VC) for checkout and payment, agent key bound by cnf, verifier receipts. Agent-to-agent delegation is out of its scope.', proxyproof: 'Reference. ProxyProof’s buyer mandate follows the same idea (cnf-bound key, exact checkout hash) but is not AP2 format. An AP2 adapter is future work.' },
  { name: 'PayPal Orders v2, MCP server, Agent Toolkit', status: 'Available', covers: 'Checkout create and capture; PayPal tools for agents using merchant credentials.', proxyproof: 'Integration: ProxyProof’s executor calls Orders v2 in the sandbox, only with a permit.' },
  { name: 'PayPal Agent Ready', status: 'Available to merchants', covers: 'Accepting agent-initiated payments via ACP (delegated tokens) and UCP.', proxyproof: 'Not used. A plain Orders v2 checkout is not Agent Ready.' },
  { name: 'PayPal MCP Gateway (internal)', status: 'Described 8 Oct 2026', covers: 'Caller identity carried through tool discovery, authorization and execution inside PayPal.', proxyproof: 'Reference only. Re-checking authority at execution time is PayPal’s stated principle too.' },
  { name: 'ACP / UCP', status: 'Beta / published', covers: 'Commerce checkout interaction; UCP’s AP2 extension has the business sign the checkout and the user sign a mandate.', proxyproof: 'Reference. UCP binds both parties to one checkout but trusts the business key directly, not a seller agent.' },
  { name: 'Visa Trusted Agent Protocol', status: 'Published', covers: 'Merchants recognise registered buyer agents from signed requests.', proxyproof: 'Reference only; not used or simulated.' },
  { name: 'Mastercard Verifiable Intent', status: 'Draft v0.1', covers: 'Layered SD-JWT evidence of user intent and agent action.', proxyproof: 'Reference only.' },
  { name: 'OpenID AuthZEN 1.0', status: 'Final (Jan 2026)', covers: 'Standard PDP/PEP evaluation API.', proxyproof: 'Future: expose each side’s check as an AuthZEN evaluation.' },
  { name: 'EMILIA, AAP, WIMSE cross-org, delegation receipts', status: 'Individual drafts / projects', covers: 'Exact-action single-use authorization, narrowing delegation, cross-org requirements.', proxyproof: 'Reference. ProxyProof’s permit is its own minimal version of an idea EMILIA already demonstrates.' },
  { name: 'Open Agent Commerce', status: 'Demonstration, Oct 2026', covers: 'Buyer and seller agents check each other; independent verifier.', proxyproof: 'Strongest bilateral prior art found. It notes no seller-business-to-seller-agent mandate and no co-signed object.' },
];

const ADDS: { what: string; status: Status; detail: string }[] = [
  { what: 'Seller-side business delegation verification', status: 'Implementation', detail: 'The seller business signs which agent key may quote, invoice and request payment, to which buyers, up to what amount, into which account.' },
  { what: 'Independent buyer and seller authority checks', status: 'Implementation', detail: 'Each side verified on its own: key possession, organization trust, delegation signature and binding, expiry and revocation, scope, counterparty.' },
  { what: 'Bilateral matching to one transaction', status: 'Implementation', detail: 'Both agents sign the same canonical terms hash; any difference is a mismatch, never coerced.' },
  { what: 'Deterministic policy decision', status: 'Implementation', detail: 'Allow, Hold, Review or Deny with exact reason codes; no model takes part.' },
  { what: 'Transaction-bound execution permit', status: 'Implementation', detail: 'Single-use, five-minute permit for one action on one terms hash; the executor re-verifies both sides before PayPal.' },
  { what: 'Combined evidence bundle', status: 'Implementation', detail: 'Both chains, every check, the decision receipt, permits and the provider outcome, signed and independently verifiable.' },
  { what: 'MCP connector and REST API for external agents', status: 'Integration', detail: 'Streamable HTTP MCP (2026-07-28) with connection tokens; REST with agent-held keys.' },
  { what: 'Delegation credential format', status: 'Experimental', detail: 'W3C VC 2.0-shaped vc+jwt with RFC 7800 key binding. A ProxyProof demo profile, not validated against VC conformance suites.' },
  { what: 'AP2, AuthZEN and Visa TAP adapters, KYB, federation', status: 'Future', detail: 'Not in this build.' },
];

const FLOW: { stage: string; existing: string; adds: string; why: string; test: string; notDone?: string }[] = [
  { stage: 'Organizations enroll', existing: 'Keys and DIDs (did:key, JOSE).', adds: 'Organization registry with key status; demo enrollment disclosed as such.', why: 'A signature is only as good as the key-to-business binding.', test: 'ORG_NOT_ESTABLISHED holds unverified organizations', notDone: 'Legal or KYB verification' },
  { stage: 'Agents connect', existing: 'MCP transports; OAuth for MCP.', adds: 'Connection token or agent-held key, with an honest assurance label. Default state: Connected, not authorized.', why: 'A platform name or an OAuth session is not proof of an agent instance.', test: 'MCP: missing or wrong token refused; connected agent cannot act' },
  { stage: 'Organizations delegate', existing: 'VC data model, RFC 7800 cnf, delegation-receipt drafts.', adds: 'Signed buyer mandates and seller business delegations, approved by a person, bound to one agent key.', why: 'The agent can never authorize itself.', test: 'SELF_DELEGATION, WRONG_ISSUER, DELEGATION_FORGED' },
  { stage: 'Seller agent offers', existing: 'Signed requests (JWS, EdDSA), challenges.', adds: 'Offer signed over the canonical terms hash, verified against the seller business delegation and enrolled account.', why: 'A buyer must know the invoice comes from someone allowed to issue it.', test: 'ACTION_NOT_PERMITTED, DESTINATION_NOT_AUTHORIZED, TERMS_MODIFIED' },
  { stage: 'Buyer agent accepts', existing: 'AP2-style mandate binding.', adds: 'Acceptance signed over the same terms hash, verified against the buyer mandate.', why: 'A seller must know the buyer’s agent may commit the buyer.', test: 'AMOUNT_EXCEEDS_LIMIT, DELEGATION_REVOKED, REPLAY' },
  { stage: 'Match and decide', existing: '—', adds: 'Both chains plus the exact term match, then a deterministic decision.', why: 'Two valid agents can still disagree on terms.', test: 'TERMS_MISMATCH, TERMS_EXPIRED, REVIEW_REQUIRED' },
  { stage: 'Execution permit', existing: 'Exact-action single-use gates (EMILIA).', adds: 'Five-minute permit bound to terms hash and action; executor re-verifies on live state.', why: 'Authority can change between decision and payment.', test: 'PERMIT_ALREADY_USED, TERMS_CHANGED, LIVE_RECHECK_FAILED' },
  { stage: 'PayPal sandbox checkout', existing: 'PayPal Orders v2.', adds: 'Called only by the executor; buyer approves on PayPal; completion only on provider confirmation.', why: 'Payment approval stays with the buyer.', test: 'Completion only after confirmed capture; unverified webhooks ignored', notDone: 'Agent Ready / delegated tokens' },
  { stage: 'Evidence bundle', existing: 'JWS, JWKS.', adds: 'Signed bundle of both chains, checks, decision, permits and outcome.', why: 'Anyone can check what was verified, offline.', test: 'Bundle verifies; any edit breaks the digest' },
];

export function Explorer() {
  const [tab, setTab] = useState<'ecosystem' | 'adds' | 'flow'>('flow');
  const [report, setReport] = useState<any>(null);
  useEffect(() => { api.get('/api/test-report').then(setReport).catch(() => setReport({ available: false })); }, []);
  return (
    <div className="landing explorer">
      <header className="top"><div className="top-inner">
        <Link className="brand" to="/"><Monogram size={30} />ProxyProof</Link><span className="spacer" />
        <Link className="btn btn-sm btn-primary" to="/">Back</Link>
      </div></header>
      <main>
        <section className="sec" style={{ marginTop: 40 }}>
          <h1 style={{ fontSize: 'clamp(26px, 3vw, 38px)', fontWeight: 800 }}>How ProxyProof works</h1>
          <p className="sub">What already exists, what ProxyProof adds, and how one transaction flows. Every capability is labelled by status.</p>
          <div className="row legend">{(Object.keys(STATUS_HELP) as Status[]).map((s) => <span key={s} className={`status s-${s}`} title={STATUS_HELP[s]}>{s}</span>)}</div>
          <div className="seg" role="tablist" style={{ marginTop: 18 }}>
            {([['flow', 'End-to-end flow'], ['adds', 'What ProxyProof adds'], ['ecosystem', 'Existing ecosystem']] as const).map(([k, l]) => <button key={k} role="tab" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        </section>

        {tab === 'flow' && <section className="flowlist">
          {FLOW.map((f, i) => (
            <article key={f.stage} className="stage-card">
              <div className="stage-n">{i + 1}</div>
              <div>
                <h3>{f.stage}</h3>
                <dl className="kv wide">
                  <dt>Already exists</dt><dd>{f.existing}</dd>
                  <dt>ProxyProof adds</dt><dd>{f.adds}</dd>
                  <dt>Why it matters</dt><dd>{f.why}</dd>
                  <dt>Tested by</dt><dd className="mono small">{f.test}</dd>
                  {f.notDone && <><dt>Not implemented</dt><dd>{f.notDone}</dd></>}
                </dl>
              </div>
            </article>
          ))}
          <p className="small muted">If any stage fails, the path stops there: the decision is Hold, Review or Deny with the exact reason, no permit is issued, and the executor is never called.</p>
        </section>}

        {tab === 'adds' && <section className="table-wrap"><table className="cmp">
          <thead><tr><th>Capability</th><th>Status</th><th>What it does</th></tr></thead>
          <tbody>{ADDS.map((a) => <tr key={a.what}><td><strong>{a.what}</strong></td><td><span className={`status s-${a.status}`}>{a.status}</span></td><td>{a.detail}</td></tr>)}</tbody>
        </table></section>}

        {tab === 'ecosystem' && <section className="table-wrap"><table className="cmp">
          <thead><tr><th>System</th><th>Status</th><th>What it already covers</th><th>ProxyProof’s role</th></tr></thead>
          <tbody>{ECOSYSTEM.map((e) => <tr key={e.name}><td><strong>{e.name}</strong></td><td className="small">{e.status}</td><td>{e.covers}</td><td>{e.proxyproof}</td></tr>)}</tbody>
        </table><p className="small muted" style={{ marginTop: 10 }}>Sources and dates: docs/research/competitive-landscape.md and standards-status.md in the repository. ProxyProof is not affiliated with or endorsed by any of these organizations.</p></section>}

        <section className="sec" aria-labelledby="rel-h">
          <h2 id="rel-h">Measured results</h2>
          {!report || report.available === false ? <p className="sub">No test report has been generated on this server yet. Run <code>npm run test:report</code>.</p> : <>
            <p className="sub">From the automated suite, run {new Date(report.generated_at).toLocaleString()} on {report.environment}. {report.total} tests, {report.passed} passed, {report.failed} failed. These prove only the tested properties, not production reliability.</p>
            <div className="table-wrap"><table className="cmp">
              <thead><tr><th>Property</th><th>Tests</th><th>Result</th></tr></thead>
              <tbody>{report.properties.map((p: any) => <tr key={p.name}><td>{p.name}</td><td>{p.tests}</td><td><span className={`chip ${p.failed ? 'fail' : 'pass'}`}>{p.failed ? `${p.failed} failed` : 'All passed'}</span></td></tr>)}</tbody>
            </table></div>
            {report.latency && <p className="small muted" style={{ marginTop: 10 }}>Verification latency (offer + acceptance, both sides and match, {report.latency.samples} runs, in-process): p50 {report.latency.p50_ms} ms, p95 {report.latency.p95_ms} ms.</p>}
          </>}
        </section>
      </main>
    </div>
  );
}
