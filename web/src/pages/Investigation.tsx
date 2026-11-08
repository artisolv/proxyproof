import { Fragment, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, money, toMinor, when } from '../api';
import { can, useMe } from '../main';
import { AgentIcon, Checklist, Chip, DECISION_WORD, ErrorNote, Loading, Modal, OUTCOME, OutcomeChip, PersonIcon, useLoad, useToast } from '../ui';

const PROVENANCE: Record<string, string> = { TRUSTED_REGISTRY: 'Your trusted registry', HISTORY: 'Your history', USER_PROVIDED: 'Uploaded file', PROVIDER_CONFIRMED: 'Payment provider', PUBLIC_SOURCE: 'Public source', MODEL_INFERRED: 'AI inference', SYSTEM_COMPUTED: 'Computed check' };
const STANCE: Record<string, string> = { SUPPORTS: 'Supports', CONTRADICTS: 'Contradicts', UNKNOWN: 'Unknown', NEUTRAL: 'Context' };
const EFFECT_WORD: Record<string, string> = { ALLOW: 'Allow', REVIEW: 'Review', HOLD: 'Hold', DENY: 'Deny' };
const FIELD_LABEL: Record<string, string> = { vendorName: 'Vendor', invoiceNumber: 'Invoice number', invoiceDate: 'Invoice date', dueDate: 'Due date', currency: 'Currency', total: 'Total', subtotal: 'Subtotal', tax: 'Tax', purchaseOrder: 'Purchase order' };
const DEST_WORD: Record<string, string> = { PAYPAL_EMAIL: 'PayPal account', IBAN: 'IBAN', BANK_ACCOUNT: 'Bank account', OTHER: 'Other' };
const NEXT_STEP: Record<string, string> = {
  DESTINATION_MISMATCH: 'Call the vendor on a number you already had, not one from this invoice or email, and ask whether their payment details changed.',
  DESTINATION_UNVERIFIED: 'Confirm the payment destination through a channel you established independently before adding it.',
  VENDOR_UNKNOWN: 'Register the vendor only after confirming who they are through an onboarding process you trust.',
  SENDER_LOOKALIKE_DOMAIN: 'Treat this as impersonation. Do not reply to the email. Contact the real vendor directly.',
  REPLY_TO_MISMATCH: 'Do not reply to this message. Start a new message to the vendor’s known address.',
  DUPLICATE_FILE: 'Check whether this invoice was already submitted or paid.', DUPLICATE_INVOICE_NUMBER: 'Compare it with the earlier invoice of the same number.', DUPLICATE_CONTENT: 'Compare it with the earlier invoice it matches.',
  ALREADY_PAID: 'No action needed: the earlier payment stands.', TOTALS_INCONSISTENT: 'Ask the vendor for a corrected invoice.',
  EMBEDDED_INSTRUCTIONS: 'Read the quoted text below. Legitimate invoices do not address software.', AGENT_REVOKED: 'Issue a new agent identity if this agent should work again.',
  AUTH_EXPIRED: 'Issue a new authorization if the agent should keep paying this vendor.', VERIFICATION_UNAVAILABLE: 'Evaluate again once the service is back.',
};

export function Investigation() {
  const { id } = useParams();
  const { me } = useMe();
  const toast = useToast();
  const { data: c, error, reload } = useLoad<any>(`/api/payment-requests/${id}`, [id]);
  const [modal, setModal] = useState<null | 'release' | 'approve' | 'reject' | 'verify' | 'amend'>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const role = me.user?.role;
  // Poll while the provider has not reported a final state.
  useEffect(() => {
    if (!c || !['PAYMENT_PENDING', 'EXECUTING'].includes(c.status)) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [c?.status]);
  if (error) return <ErrorNote error={error} retry={reload} />;
  if (!c) return <Loading lines={6} />;

  const d = c.decision;
  const active = d ? d.reasons.filter((r: any) => !d.satisfiedByApproval.includes(r.code)) : [];
  const verdict = d?.decision ?? 'NONE';
  const a = c.assessment;
  const VCLASS: Record<string, string> = { ALLOWED: 'ALLOW', COMPLETED: 'ALLOW', UNDER_REVIEW: 'REVIEW', HELD: 'HOLD', DENIED: 'DENY', FAILED: 'DENY' };
  const executorCalled = Boolean(c.attempt);
  const refused = c.gate.filter((g: any) => g.outcome === 'REFUSED');
  const blocked = d && d.decision !== 'ALLOW';
  const act = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true); setActionError(null);
    try { await fn(); toast(ok); setModal(null); await reload(); } catch (e: any) { setActionError(e.message); } finally { setBusy(false); }
  };
  const gateStep = executorCalled ? 'done' : blocked ? 'blocked' : 'unreached';
  const providerStep = c.attempt?.status === 'COMPLETED' ? 'done' : 'unreached';
  const steps = [
    ['Request received', c.origin === 'AGENT' ? `From agent ${c.agent?.name ?? 'unregistered'}` : 'Uploaded by a person', 'done'],
    ['Evidence checked', `${c.evidence.length} evidence items`, 'done'],
    ['Policy decided', d ? `${DECISION_WORD[d.decision]} under policy v${d.policy_version}` : 'Not yet', d ? 'done' : 'unreached'],
    ['Gate', executorCalled ? 'Passed. Payment claimed once.' : blocked ? 'Stopped here. The executor was not called.' : 'Waiting for someone to release it.', gateStep],
    ['PayPal sandbox', c.attempt ? `${c.attempt.status === 'COMPLETED' ? 'Completed' : c.attempt.status.toLowerCase().replace('_', ' ')}${c.attempt.provider_ref ? `, ${c.attempt.provider_ref}` : ''}` : 'Not contacted', providerStep],
  ];
  const ext = c.invoice?.extraction;
  const destinations = c.vendor?.destinations?.filter((x: any) => x.status === 'VERIFIED') ?? [];
  const destMismatch = active.some((r: any) => ['DESTINATION_MISMATCH', 'DESTINATION_UNVERIFIED'].includes(r.code));

  return (
    <div className="stack">
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <Link to="/app/transactions" className="small muted">Transactions</Link>
          <h1 className="h1" style={{ marginTop: 6 }}>{c.vendor?.name ?? c.payee_name ?? 'Unknown payee'}, {money(c.amount_minor, c.currency ?? 'USD')}</h1>
          <div className="row" style={{ marginTop: 10 }}><OutcomeChip o={a.outcome} />{a.reference && <span className="small">Invoice {a.reference}</span>}{c.readOnly && <Chip tone="NEUTRAL">Challenge run, read only</Chip>}<span className="muted small">Revision {c.revision} · received {when(c.created_at)}</span></div>
        </div>
        <div className="row"><a className="btn btn-sm btn-quiet" href={`/api/payment-requests/${c.id}/report.pdf`}>Download PDF report</a><a className="btn btn-sm btn-quiet" href={`/api/payment-requests/${c.id}/report.json`}>Download JSON</a></div>
      </div>

      <div className="answers" aria-label="Summary">
        <div><div className="k">Requested</div><div className="v">{money(c.amount_minor, c.currency ?? 'USD')}{c.category ? `, ${c.category}` : ''}</div></div>
        <div><div className="k">Initiated by</div><div className="v who-ic">{a.initiator.kind === 'AGENT' ? <AgentIcon /> : <PersonIcon />}{a.initiator.name}{a.initiator.kind === 'AGENT' ? ' (AI agent)' : ''}</div></div>
        <div><div className="k">Receiving the money</div><div className="v">{a.payee}{c.destination ? <div className="tiny muted" style={{ fontWeight: 400 }}>{DEST_WORD[c.destination.type]} {c.destination.value}</div> : null}</div></div>
        <div><div className="k">Did money move?</div><div className="v">{a.outcome === 'COMPLETED' ? `Yes. PayPal confirmed ${c.attempt?.provider_ref ?? 'the payment'}` : a.executorCalled ? 'Sent to PayPal, not yet confirmed' : 'No. The executor was not called'}</div></div>
      </div>

      <section className={`verdict ${VCLASS[a.outcome] ?? verdict}`} aria-live="polite">
        <div className="word">{OUTCOME[a.outcome]?.label ?? 'Not evaluated'}</div>
        <p className="why">{a.reason}</p>
        {a.nextAction && <p className="small" style={{ marginTop: 8, fontWeight: 600 }}>Next: {a.nextAction}</p>}
        <div className="verdict-meta">
          {d && <span>{d.reasons.length} of {d.rulesChecked} rules fired</span>}
          <span>Executor {executorCalled ? 'called once' : 'not called'}</span>
          {refused.length > 0 && <span>{refused.length} release attempt{refused.length > 1 ? 's' : ''} refused</span>}
          {d && <span>Fingerprint <code>{d.fingerprint.slice(0, 16)}</code></span>}
        </div>
        <div className="path"><ol>{steps.map(([t, s, state]) => <li key={t} className={`${state}${state === 'done' ? ' anim' : ''}`}><span className="dot" />{t}<span className="sub">{s}</span></li>)}</ol></div>
      </section>

      {!c.readOnly && <Actions c={c} role={role} active={active} destMismatch={destMismatch} setModal={setModal} busy={busy} act={act} reload={reload} />}
      {actionError && !modal && <div className="notice error" role="alert">{actionError}</div>}

      <div className="grid-2">
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2 className="h3">What was verified</h2><span className="muted small">From the facts the policy engine evaluated</span></div>
            <Checklist checks={a.checks} />
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="h3">Why</h2><span className="muted small">Rules that fired, strictest first</span></div>
            {d?.reasons.length ? <div className="reveal">{d.reasons.map((r: any) => (
              <div key={r.code} className={`reason${d.satisfiedByApproval.includes(r.code) ? ' satisfied' : ''}`}>
                <Chip tone={r.effect}>{EFFECT_WORD[r.effect]}</Chip>
                <div><div style={{ fontWeight: 650 }}>{r.message}</div>
                  <div className="code">{r.code}{d.satisfiedByApproval.includes(r.code) ? ' · satisfied by a recorded approval' : ''}{r.approvable ? '' : ' · a person cannot override this'}</div>
                  {NEXT_STEP[r.code] && !d.satisfiedByApproval.includes(r.code) && <div className="small muted" style={{ marginTop: 4 }}>{NEXT_STEP[r.code]}</div>}</div>
              </div>))}</div> : <p className="muted">No rule fired. The vendor, destination, amount, history and authority all check out.</p>}
            {c.signals?.injection?.length > 0 && <div className="notice warn" style={{ marginTop: 14 }}><strong>Text aimed at software, quoted and ignored:</strong><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{c.signals.injection.slice(0, 4).map((s: string, i: number) => <li key={i}><q>{s}</q></li>)}</ul></div>}
            {c.rejectedFile && <div className="notice error" style={{ marginTop: 14 }}>{c.rejectedFile}</div>}
          </section>

          <section className="panel">
            <div className="panel-head"><h2 className="h3">Evidence</h2><span className="muted small">Each item says where it came from and how far to trust it</span></div>
            {c.evidence.length ? <div className="reveal">{c.evidence.map((e: any) => (
              <div className="ev" key={e.id}>
                <div className="ev-top"><span className="ev-claim">{e.claim}</span><Chip tone={e.stance}>{STANCE[e.stance]}</Chip></div>
                <div className="ev-meta"><span>{e.source}</span><span>{PROVENANCE[e.provenance]}</span><span>Reliability {e.reliability.toLowerCase()}</span><span>{when(e.retrieved_at)}</span></div>
                {e.provenance === 'MODEL_INFERRED' && e.details?.explanation && <p className="small">{e.details.explanation}</p>}
                {e.limitations && <p className="small muted">{e.limitations}</p>}
              </div>))}</div> : <p className="muted">No evidence was gathered.</p>}
          </section>

          {(c.summary || c.recommendedSteps.length > 0) && <section className="panel panel-mist">
            <h2 className="h3">AI investigator notes</h2>
            <p className="small muted" style={{ marginBottom: 10 }}>Written by {c.modelName}. Model inference, not verified fact. It cannot approve or allow anything.</p>
            {c.summary && <p>{c.summary}</p>}
            {c.recommendedSteps.length > 0 && <ul style={{ marginTop: 10, paddingLeft: 18 }}>{c.recommendedSteps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ul>}
          </section>}

          <section className="panel">
            <div className="panel-head"><h2 className="h3">Audit trail</h2><Link to="/app/settings?tab=audit" className="small">Verify the chain</Link></div>
            <ol className="timeline">{c.timeline.map((t: any) => (
              <li key={t.seq}><span className="n">{t.seq}</span><div><div className="t">{t.event_type.toLowerCase().replace(/_/g, ' ').replace(/^./, (x: string) => x.toUpperCase())}</div>
                <div className="small muted">{t.actor_type.toLowerCase()} · {when(t.created_at)}</div><div className="hash">{t.hash}</div></div></li>))}</ol>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2 className="h3">Where the money would go</h2>
            <div className="compare">
              <div className={destMismatch ? 'bad' : c.destination ? 'good' : ''}><div className="k">This request asks for</div><div className="v">{c.destination ? `${DEST_WORD[c.destination.type]} ${c.destination.value}` : 'No destination stated'}</div></div>
              <div><div className="k">Verified on file</div><div className="v">{destinations.length ? destinations.map((x: any) => `${DEST_WORD[x.type]} ${x.value}`).join(', ') : 'Nothing verified'}</div></div>
            </div>
            {destinations[0]?.verification_method && <p className="small muted" style={{ marginTop: 10 }}>Verified by: {destinations[0].verification_method}</p>}
          </section>

          <section className="panel">
            <h2 className="h3">Transaction</h2>
            <dl className="kv">
              <dt>Amount</dt><dd>{money(c.amount_minor, c.currency ?? 'USD')}</dd>
              <dt>Payee</dt><dd>{c.vendor ? <>{c.vendor.name} <Chip tone={c.vendor.status}>{c.vendor.status.toLowerCase()}</Chip></> : 'Not in your directory'}</dd>
              <dt>Category</dt><dd>{c.category ?? 'None'}</dd>
              <dt>Payment rail</dt><dd>{c.rail === 'ORDERS' ? 'PayPal Checkout (buyer approves)' : 'PayPal Payouts'}</dd>
              {d?.tte && <><dt>Policy version</dt><dd>{d.tte.policy_version}</dd><dt>Invoice fingerprint</dt><dd className="hash">{d.tte.invoice_fingerprint ?? 'None'}</dd><dt>Transaction fingerprint</dt><dd className="hash">{d.fingerprint}</dd></>}
            </dl>
          </section>

          {c.invoice && <section className="panel">
            <div className="panel-head"><h2 className="h3">Invoice as read</h2><span className="muted small">{ext?.method?.join(' and ')}{c.aiExtraction ? '' : ''}</span></div>
            <dl className="kv">{Object.keys(FIELD_LABEL).map((k) => {
              const f = ext?.[k];
              if (!f) return null;
              const val = f.status === 'FOUND' ? (['total', 'subtotal', 'tax'].includes(k) ? money(f.value, c.invoice.currency ?? 'USD') : f.value) : f.status === 'CONFLICT' ? `Conflict: ${(f.candidates ?? []).map((x: any) => (typeof x === 'number' ? money(x, c.invoice.currency ?? 'USD') : x)).join(' vs ')}` : 'Unknown';
              return <Fragment key={k}><dt>{FIELD_LABEL[k]}</dt><dd>{f.status === 'FOUND' ? val : <Chip tone={f.status === 'CONFLICT' ? 'DENY' : 'HOLD'}>{val}</Chip>}{f.source && f.status === 'FOUND' && <span className="muted tiny"> · {f.source}</span>}</dd></Fragment>;
            })}</dl>
            {c.invoice.lines.length > 0 && <div className="table-wrap" style={{ marginTop: 14 }}><table><thead><tr><th>Line item</th><th className="num">Amount</th></tr></thead><tbody>{c.invoice.lines.map((l: any, i: number) => <tr key={i}><td>{l.description}</td><td className="num">{money(l.amount_minor, c.invoice.currency ?? 'USD')}</td></tr>)}</tbody></table></div>}
          </section>}

          {c.history.length > 0 && <section className="panel"><h2 className="h3">Earlier invoices from this vendor</h2>
            <div className="table-wrap"><table><thead><tr><th>Invoice</th><th className="num">Amount</th><th>Paid</th></tr></thead><tbody>{c.history.map((h: any, i: number) => <tr key={i}><td>{h.number ?? 'None'}{h.is_seed_history ? <span className="muted tiny"> · demo history</span> : ''}</td><td className="num">{money(h.total_minor, h.currency ?? 'USD')}</td><td>{h.payment_status === 'COMPLETED' ? 'Yes' : 'No'}</td></tr>)}</tbody></table></div></section>}

          {c.agent && <section className="panel"><h2 className="h3">Agent authority</h2>
            <dl className="kv">
              <dt>Agent</dt><dd>{c.agent.name ?? <Chip tone="DENY">Not registered</Chip>} <span className="hash">{c.agent.id}</span></dd>
              <dt>Signature</dt><dd><Chip tone={c.agent.check?.signature === 'VALID' ? 'ALLOW' : 'DENY'}>{c.agent.check?.signature?.toLowerCase()}</Chip></dd>
              <dt>Authorization</dt><dd><Chip tone={c.agent.check?.grantFormat === 'VALID' ? 'ALLOW' : 'DENY'}>{c.agent.check?.grantFormat?.toLowerCase().replace('_', ' ')}</Chip>{c.agent.check?.replayedNonce && <> <Chip tone="DENY">replayed</Chip></>}</dd>
              {c.agent.authorization && <><dt>Grant</dt><dd>Version {c.agent.authorization.version}, {c.agent.authorization.status.toLowerCase()}, expires {when(c.agent.authorization.expires_at)}</dd>
                <dt>Limits</dt><dd>{money(c.agent.authorization.per_tx_max_minor)} per payment, {money(c.agent.authorization.daily_budget_minor)} a day</dd></>}
            </dl>
            <p className="small muted" style={{ marginTop: 10 }}>Internal PayeeProof scoped authorization (EdDSA-signed). It is not an AP2 mandate and was not issued by PayPal.</p></section>}

          {c.email && <section className="panel"><h2 className="h3">Email</h2><dl className="kv">
            <dt>From</dt><dd>{c.email.fromName ? `${c.email.fromName} ` : ''}&lt;{c.email.from}&gt;</dd>{c.email.replyTo && <><dt>Reply-To</dt><dd>{c.email.replyTo}</dd></>}<dt>Subject</dt><dd>{c.email.subject}</dd>
            {c.email.authenticationResults?.present && <><dt>Authentication</dt><dd>SPF {c.email.authenticationResults.spf ?? 'absent'}, DKIM {c.email.authenticationResults.dkim ?? 'absent'}, DMARC {c.email.authenticationResults.dmarc ?? 'absent'}</dd></>}</dl></section>}

          <section className="panel"><h2 className="h3">Files</h2>
            {c.artifacts.length ? c.artifacts.map((a: any) => <div key={a.id} style={{ marginBottom: 10 }}><div style={{ fontWeight: 600 }}>{a.filename} <span className="muted tiny">{a.kind.toLowerCase()}, {(a.size_bytes / 1024).toFixed(1)} KB</span></div><div className="hash">sha256 {a.sha256}</div></div>) : <p className="muted">No files. This was a structured request.</p>}</section>

          {(c.approvals.length > 0 || c.attempt) && <section className="panel"><h2 className="h3">Approvals and payment</h2>
            {c.approvals.map((a: any, i: number) => <p key={i} className="small" style={{ marginBottom: 6 }}><Chip tone={a.action}>{a.action === 'APPROVE' ? 'Approved' : 'Rejected'}</Chip> by {a.approver}, {when(a.created_at)}{a.invalidated_at ? ' · void: the transaction changed afterwards' : ''}</p>)}
            {c.attempt && <dl className="kv" style={{ marginTop: 10 }}><dt>Provider</dt><dd>PayPal sandbox, {c.attempt.rail === 'ORDERS' ? 'Checkout' : 'Payouts'}</dd><dt>Status</dt><dd><Chip tone={c.attempt.status}>{c.attempt.status.toLowerCase().replace('_', ' ')}</Chip> {c.attempt.provider_status && <span className="muted small">PayPal: {c.attempt.provider_status}</span>}</dd><dt>Reference</dt><dd className="hash">{c.attempt.provider_ref ?? 'None yet'}</dd><dt>Confirmed by</dt><dd>{c.attempt.confirmed_by ?? 'Not confirmed yet'}</dd>{c.attempt.failure && <><dt>Failure</dt><dd>{c.attempt.failure}</dd></>}<dt>Idempotency key</dt><dd className="hash">{c.attempt.idempotency_key}</dd></dl>}
            {c.providerEvents.length > 0 && <p className="small muted" style={{ marginTop: 10 }}>{c.providerEvents.length} verified webhook event(s) received.</p>}
          </section>}
        </div>
      </div>

      {modal === 'release' && <Modal title="Release this payment" onClose={() => setModal(null)}>
        <ReleaseForm c={c} busy={busy} error={actionError} onSubmit={(rail: string) => act(async () => {
          if (rail !== c.rail) await api.post(`/api/payment-requests/${c.id}/rail`, { rail });
          const r = await api.post(`/api/payment-requests/${c.id}/execute`, { decision_id: d.id });
          if (r.approveUrl) window.open(r.approveUrl, '_blank', 'noopener');
        }, 'Sent to the PayPal sandbox. Waiting for confirmation.')} />
      </Modal>}
      {(modal === 'approve' || modal === 'reject') && <Modal title={modal === 'approve' ? 'Approve this exact transaction' : 'Reject this transaction'} onClose={() => setModal(null)}>
        <ApproveForm c={c} kind={modal} busy={busy} error={actionError} onSubmit={(comment: string) => act(() => api.post(`/api/payment-requests/${c.id}/${modal}`, { fingerprint: d.fingerprint, comment }), modal === 'approve' ? 'Approved. The request was evaluated again.' : 'Rejected.')} />
      </Modal>}
      {modal === 'verify' && <Modal title="Verify this payment destination" onClose={() => setModal(null)}>
        <VerifyForm c={c} busy={busy} error={actionError} onSubmit={(method: string) => act(async () => { await api.post(`/api/vendors/${c.vendor.id}/verify`, { method, destination: { type: c.destination.type, value: c.destination.value } }); await api.post(`/api/payment-requests/${c.id}/analyze`); }, 'Destination verified. The request was evaluated again.')} />
      </Modal>}
      {modal === 'amend' && <Modal title="Change payment details" onClose={() => setModal(null)}>
        <AmendForm c={c} busy={busy} error={actionError} onSubmit={(b: any) => act(() => api.post(`/api/payment-requests/${c.id}/amend`, b), 'Changed. Earlier approvals no longer apply.')} />
      </Modal>}
    </div>
  );
}

function Actions({ c, role, active, destMismatch, setModal, busy, act, reload }: any) {
  const d = c.decision;
  const finance = can(role, ['OWNER', 'FINANCE_ADMIN']);
  const terminal = ['COMPLETED', 'EXECUTING', 'PAYMENT_PENDING', 'REJECTED'].includes(c.status);
  if (c.status === 'PAYMENT_PENDING' && c.attempt?.rail === 'ORDERS') return (
    <section className="panel row"><div style={{ flex: 1 }}><strong>Waiting for the buyer to approve in the PayPal sandbox.</strong><p className="small muted">After approval, complete the capture. The redirect alone never marks a payment as paid.</p></div>
      {c.attempt.approve_url && <a className="btn btn-secondary" href={c.attempt.approve_url} target="_blank" rel="noopener">Open PayPal approval</a>}
      {finance && <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api.post(`/api/payment-requests/${c.id}/capture`), 'Capture requested from PayPal.')}>Complete payment</button>}</section>
  );
  if (terminal) return c.status === 'PAYMENT_PENDING' ? <div className="notice row"><span style={{ flex: 1 }}>The payment was sent. Waiting for PayPal to confirm it.</span><button className="btn btn-sm btn-secondary" onClick={reload}>Check status</button></div> : null;
  if (!d) return null;
  return (
    <section className="panel row" aria-label="Actions">
      <div style={{ flex: 1, minWidth: 240 }}>
        {d.decision === 'ALLOW' && (c.attempt?.status === 'FAILED'
          ? <><strong>PayPal did not complete the last attempt.</strong><p className="small muted">{c.attempt.failure ?? 'No reason was given.'} Nothing was marked paid. You can release it again.</p></>
          : <><strong>Ready to pay.</strong><p className="small muted">Releasing runs the policy again on live data before PayPal is contacted.</p></>)}
        {d.decision === 'REVIEW' && <><strong>A person must approve this exact transaction.</strong><p className="small muted">The approval is bound to fingerprint <code>{d.fingerprint.slice(0, 12)}</code>. Any change voids it.{c.origin === 'HUMAN' ? ' Whoever submitted it cannot approve it.' : ''}</p></>}
        {d.decision === 'HOLD' && <><strong>On hold until the evidence changes.</strong><p className="small muted">An approval cannot release a hold. Resolve the cause, then evaluate again.</p></>}
        {d.decision === 'DENY' && <><strong>Denied by policy.</strong><p className="small muted">This decision is final for this transaction.</p></>}
      </div>
      {d.decision === 'ALLOW' && <button className="btn btn-primary" disabled={!finance} title={finance ? '' : 'Only an owner or finance admin can release payments'} onClick={() => setModal('release')}>Release payment</button>}
      {d.decision === 'REVIEW' && <><button className="btn btn-primary" disabled={!finance} onClick={() => setModal('approve')}>Approve</button><button className="btn btn-danger" disabled={!finance} onClick={() => setModal('reject')}>Reject</button></>}
      {d.decision === 'HOLD' && destMismatch && c.vendor && c.destination && finance && <button className="btn btn-secondary" onClick={() => setModal('verify')}>I verified this destination</button>}
      {d.decision === 'HOLD' && active.some((r: any) => r.code === 'VENDOR_UNKNOWN') && finance && <Link className="btn btn-secondary" to={`/app/payees?new=1&name=${encodeURIComponent(c.invoice?.vendor_name ?? c.payee_name ?? '')}&dest=${encodeURIComponent(c.destination?.value ?? '')}&request=${c.id}`}>Register this vendor</Link>}
      {finance && <button className="btn btn-quiet" onClick={() => setModal('amend')}>Change details</button>}
      {can(role, ['OWNER', 'FINANCE_ADMIN', 'REVIEWER']) && <button className="btn btn-quiet" disabled={busy} onClick={() => act(() => api.post(`/api/payment-requests/${c.id}/analyze`), 'Evaluated again with the current policy.')}>Evaluate again</button>}
      {!finance && d.decision !== 'DENY' && <span className="small muted">Your role can view and re-evaluate. Switch to a finance user to act.</span>}
    </section>
  );
}

function ReleaseForm({ c, busy, error, onSubmit }: any) {
  const [rail, setRail] = useState(c.rail);
  return <div className="stack-sm" style={{ marginTop: 12 }}>
    <dl className="kv"><dt>Pay</dt><dd>{c.vendor?.name}</dd><dt>To</dt><dd>{c.destination?.value}</dd><dt>Amount</dt><dd><strong>{money(c.amount_minor, c.currency)}</strong></dd></dl>
    <label className="field">Payment rail<select className="input" value={rail} onChange={(e) => setRail(e.target.value)}><option value="PAYOUTS">PayPal Payouts: sent from your sandbox business account</option><option value="ORDERS">PayPal Checkout: a sandbox buyer approves in a PayPal window</option></select></label>
    <p className="small muted">PayPal sandbox only. No real money moves. The payment counts as paid only when PayPal confirms it.</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => onSubmit(rail)}>{busy ? 'Sending…' : `Pay ${money(c.amount_minor, c.currency)}`}</button></div>
  </div>;
}
function ApproveForm({ c, kind, busy, error, onSubmit }: any) {
  const [comment, setComment] = useState('');
  const reasons = c.decision.reasons.filter((r: any) => r.approvable && !c.decision.satisfiedByApproval.includes(r.code));
  return <div className="stack-sm" style={{ marginTop: 12 }}>
    <dl className="kv"><dt>Payee</dt><dd>{c.vendor?.name ?? c.payee_name}</dd><dt>Destination</dt><dd>{c.destination?.value}</dd><dt>Amount</dt><dd><strong>{money(c.amount_minor, c.currency)}</strong></dd><dt>Invoice</dt><dd>{c.invoice?.number ?? 'None'}</dd><dt>Policy</dt><dd>Version {c.decision.policy_version}</dd><dt>Fingerprint</dt><dd className="hash">{c.decision.fingerprint}</dd></dl>
    <div className="notice"><strong>Approval is needed because:</strong><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{reasons.map((r: any) => <li key={r.code}>{r.message}</li>)}</ul></div>
    <label className="field">Note<span className="hint">Optional. Saved in the audit trail.</span><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></label>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="row"><button className={`btn ${kind === 'approve' ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={() => onSubmit(comment)}>{kind === 'approve' ? 'Approve this transaction' : 'Reject this transaction'}</button></div>
  </div>;
}
function VerifyForm({ c, busy, error, onSubmit }: any) {
  const [method, setMethod] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  return <div className="stack-sm" style={{ marginTop: 12 }}>
    <p>You are about to add <strong>{c.destination.value}</strong> as a verified destination for <strong>{c.vendor.name}</strong>. Future payments to it will pass this check.</p>
    <div className="notice warn">Only do this after confirming with the vendor through a channel you already trusted, such as a phone number from your contract. Never use contact details from this invoice or email.</div>
    <label className="field">How did you confirm it?<input className="input" value={method} onChange={(e) => setMethod(e.target.value)} placeholder="Called our account manager on the number in our signed contract" /></label>
    <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirmed this destination independently of this request.</label>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="row"><button className="btn btn-primary" disabled={busy || !confirmed || method.length < 8} onClick={() => onSubmit(method)}>Verify and evaluate again</button></div>
  </div>;
}
function AmendForm({ c, busy, error, onSubmit }: any) {
  const [amount, setAmount] = useState(c.amount_minor ? (c.amount_minor / 100).toFixed(2) : '');
  const [dest, setDest] = useState(c.destination?.value ?? '');
  return <div className="stack-sm" style={{ marginTop: 12 }}>
    <p className="small muted">Changing anything material creates a new revision. Earlier approvals and decisions stop applying, and the request is evaluated again.</p>
    <label className="field">Amount<input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
    <label className="field">PayPal destination<input className="input" value={dest} onChange={(e) => setDest(e.target.value)} /></label>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="row"><button className="btn btn-primary" disabled={busy} onClick={() => { const b: any = {}; const m = toMinor(amount); if (m && m !== c.amount_minor) b.amount_minor = m; if (dest && dest !== c.destination?.value) { b.destination_type = 'PAYPAL_EMAIL'; b.destination_value = dest; } onSubmit(b); }}>Save changes</button></div>
  </div>;
}
