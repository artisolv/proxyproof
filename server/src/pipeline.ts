import { all, one, run, tx, type DB } from './db/index.js';
import { destinationFingerprint, formatMinor, newId, normalizeInvoiceNumber, normalizeName, nowIso, parseMoneyToMinor, sha256 } from './core/util.js';
import { appendAudit, type Actor } from './core/ledger.js';
import { paymentKey, transactionFingerprint, type TTE } from './core/tte.js';
import { evaluate, type Evaluation, type Facts, type PolicyRules } from './policy/engine.js';
import { RejectedFile, ocrImage, parseEml, pdfToText, sniff, type ParsedEmail } from './ingest/files.js';
import { parseInvoiceText, scanSignals, unknown, type Extracted, type Field } from './ingest/parse.js';
import { domainOf, isLookalike, isSameOrSubdomain, nameResembles } from './evidence/domains.js';
import type { PublicEvidenceProvider, PublicResult } from './evidence/public.js';
import type { AiExtraction, ModelProvider } from './ai/model.js';
import { agentSpend, type AgentCheck, type AgentPayment } from './agents/authority.js';
import { hmac } from './core/util.js';

export type Ctx = { db: DB; model: ModelProvider; publicEvidence: PublicEvidenceProvider; decisionKey: string };
export type Upload = { filename: string; bytes: Uint8Array };
export type Faults = { registryUnavailable?: boolean };

export const currentPolicy = (db: DB, ws: string): { version: number; rules: PolicyRules; policyId: string } => {
  const p = one<any>(db, 'SELECT * FROM policies WHERE workspace_id = ?', ws);
  if (!p) throw new Error('workspace has no policy');
  const v = one<any>(db, 'SELECT rules FROM policy_versions WHERE policy_id = ? AND version = ?', p.id, p.current_version)!;
  return { version: p.current_version, rules: JSON.parse(v.rules), policyId: p.id };
};
const J = (s: string | null | undefined, d: any = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export type Snapshot = {
  extraction: Extracted | null; aiExtraction: boolean; fieldOrigins: Record<string, string>;
  email: Omit<ParsedEmail, 'text' | 'attachments'> | null;
  signals: { injection: string[]; urgency: string[]; hiddenText: string[]; websiteInjection: string[] };
  modelConcerns: number; rejectedFile: string | null; publicEvidence: PublicResult | null;
  registryAvailable: boolean; evidenceUnavailable: string[]; invoiceTextFound: boolean;
};

export function createRequest(db: DB, p: {
  workspaceId: string; origin: 'HUMAN' | 'AGENT'; principalId?: string | null; submittedBy?: string | null; agentId?: string | null; claimedAgentId?: string | null;
  agentCheck?: AgentCheck | null; vendorId?: string | null; payment?: Partial<AgentPayment>; category?: string | null; purpose?: string | null; label?: string | null; rail?: 'PAYOUTS' | 'ORDERS';
}, actor: Actor) {
  const id = newId('req'), now = nowIso();
  const dest = p.payment?.destination_value && p.payment.destination_type ? { t: p.payment.destination_type, v: p.payment.destination_value } : null;
  run(db, `INSERT INTO payment_requests (id, workspace_id, origin, principal_id, submitted_by, agent_id, claimed_agent_id, authorization_id, authorization_version, agent_check, status, vendor_id, payee_name, destination_type, destination_value, destination_fingerprint, amount_minor, currency, category, purpose, rail, label, created_at, updated_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'RECEIVED',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, p.workspaceId, p.origin, p.principalId ?? null, p.submittedBy ?? null, p.agentId ?? null, p.claimedAgentId ?? null, p.agentCheck?.authorizationId ?? null, p.agentCheck?.authorizationVersion ?? null,
    p.agentCheck ? JSON.stringify(p.agentCheck) : null, p.vendorId ?? p.payment?.vendor_id ?? null, p.payment?.payee_name ?? null, dest?.t ?? null, dest?.v ?? null, dest ? destinationFingerprint(dest.t, dest.v) : null,
    p.payment?.amount_minor ?? null, p.payment?.currency ?? null, p.category ?? p.payment?.category ?? null, p.purpose ?? p.payment?.purpose ?? null, p.rail ?? 'PAYOUTS', p.label ?? null, now, now, new Date(Date.now() + 7 * 86_400_000).toISOString());
  appendAudit(db, p.workspaceId, 'REQUEST_RECEIVED', actor, id, { origin: p.origin, agent_id: p.agentId ?? p.claimedAgentId ?? null, amount_minor: p.payment?.amount_minor ?? null, currency: p.payment?.currency ?? null });
  return id;
}

const setStatus = (db: DB, id: string, status: string) => run(db, 'UPDATE payment_requests SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), id);

/** Merges deterministic and model extraction. Disagreement on a critical field is recorded as CONFLICT, never resolved by preference. */
export function mergeModelExtraction(det: Extracted, ai: AiExtraction | null, origins: Record<string, string>): Extracted {
  if (!ai) return det;
  const out = { ...det, method: [...det.method, 'model'] };
  const str = (key: 'vendorName' | 'invoiceNumber' | 'invoiceDate' | 'dueDate' | 'purchaseOrder' | 'currency', val: string | null, norm: (s: string) => string) => {
    const f: Field = out[key];
    if (!val) return;
    if (f.status === 'FOUND' && f.value) {
      if (norm(f.value) !== norm(val)) out[key] = { value: null, status: 'CONFLICT', confidence: 0.2, source: `${f.source}; model`, candidates: [f.value, val] };
    } else if (f.status === 'UNKNOWN') { out[key] = { value: val, status: 'FOUND', confidence: 0.6, source: 'AI model only' }; origins[key] = 'MODEL_ONLY'; }
  };
  const lax = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  str('vendorName', ai.vendor_name, (s) => normalizeName(s)); str('invoiceNumber', ai.invoice_number, normalizeInvoiceNumber);
  str('invoiceDate', ai.invoice_date, lax); str('dueDate', ai.due_date, lax); str('purchaseOrder', ai.purchase_order, lax); str('currency', ai.currency, (s) => s.toUpperCase());
  const num = (key: 'total' | 'subtotal' | 'tax', raw: string | null) => {
    if (!raw) return;
    const v = parseMoneyToMinor(raw); const f: Field<number> = out[key];
    if (v === null) return;
    if (f.status === 'FOUND' && f.value !== v) out[key] = { value: null, status: 'CONFLICT', confidence: 0.2, source: `${f.source}; model`, candidates: [f.value as number, v] };
    else if (f.status === 'UNKNOWN') { out[key] = { value: v, status: 'FOUND', confidence: 0.6, source: 'AI model only' }; origins[key] = 'MODEL_ONLY'; }
  };
  num('total', ai.total_amount); num('subtotal', ai.subtotal_amount); num('tax', ai.tax_amount);
  const hasDest = (type: string, value: string) => out.destinations.some((d) => d.type === type && destinationFingerprint(d.type, d.value) === destinationFingerprint(type, value));
  if (ai.paypal_destination_email && !hasDest('PAYPAL_EMAIL', ai.paypal_destination_email)) { out.destinations = [...out.destinations, { type: 'PAYPAL_EMAIL', value: ai.paypal_destination_email.toLowerCase(), source: 'AI model only' }]; origins.destination = 'MODEL_ONLY'; }
  if (ai.bank_destination) {
    const type = /^[A-Z]{2}\d{2}/i.test(ai.bank_destination) ? 'IBAN' : 'BANK_ACCOUNT';
    if (!hasDest(type, ai.bank_destination)) { out.destinations = [...out.destinations, { type: type as any, value: ai.bank_destination.replace(/\s/g, ''), source: 'AI model only' }]; origins.destination = 'MODEL_ONLY'; }
  }
  if (!out.lineItems.length && ai.line_items.length) {
    out.lineItems = ai.line_items.flatMap((li) => { const a = parseMoneyToMinor(li.amount); return a === null ? [] : [{ description: li.description, quantity: null, unitPriceMinor: null, amountMinor: a }]; });
  }
  return out;
}

/** Adds fields from a secondary document, and flags contradictions between documents. */
function mergeDocs(primary: Extracted, secondary: Extracted): Extracted {
  const out = { ...primary, destinations: [...primary.destinations], urls: [...new Set([...primary.urls, ...secondary.urls])], emails: [...new Set([...primary.emails, ...secondary.emails])], textLength: primary.textLength + secondary.textLength };
  for (const k of ['vendorName', 'invoiceNumber', 'invoiceDate', 'dueDate', 'currency', 'purchaseOrder'] as const) if (out[k].status === 'UNKNOWN' && secondary[k].status === 'FOUND') out[k] = secondary[k];
  for (const k of ['total', 'subtotal', 'tax'] as const) {
    if (out[k].status === 'UNKNOWN' && secondary[k].status === 'FOUND') out[k] = secondary[k];
    else if (k === 'total' && out[k].status === 'FOUND' && secondary[k].status === 'FOUND' && out[k].value !== secondary[k].value)
      out[k] = { value: null, status: 'CONFLICT', confidence: 0.2, source: 'invoice and email disagree', candidates: [out[k].value as number, secondary[k].value as number] };
  }
  for (const d of secondary.destinations) if (!out.destinations.some((x) => x.type === d.type && x.value === d.value)) out.destinations.push({ ...d, source: `email ${d.source}` });
  if (!out.lineItems.length) out.lineItems = secondary.lineItems;
  return out;
}

function checkTotals(e: Extracted | null): 'CONSISTENT' | 'CONFLICT' | 'UNKNOWN' {
  if (!e) return 'UNKNOWN';
  if (e.total.status === 'CONFLICT') return 'CONFLICT';
  const total = e.total.value;
  if (total === null) return 'UNKNOWN';
  const items = e.lineItems.reduce((s, l) => s + l.amountMinor, 0);
  const tax = e.tax.value ?? 0, sub = e.subtotal.value;
  if (sub !== null && sub + tax !== total) return 'CONFLICT';
  if (e.lineItems.length) {
    if (sub !== null && items !== sub) return 'CONFLICT';
    if (sub === null && items + tax !== total) return 'CONFLICT';
    return 'CONSISTENT';
  }
  return sub !== null ? 'CONSISTENT' : 'UNKNOWN';
}

/** Ingests and extracts all files. A file failure is recorded and fails closed; it does not abort the audit trail. */
export async function ingest(ctx: Ctx, requestId: string, workspaceId: string, files: Upload[], actor: Actor): Promise<Snapshot> {
  const { db, model } = ctx;
  const snap: Snapshot = { extraction: null, aiExtraction: false, fieldOrigins: {}, email: null, signals: { injection: [], urgency: [], hiddenText: [], websiteInjection: [] }, modelConcerns: 0, rejectedFile: null, publicEvidence: null, registryAvailable: true, evidenceUnavailable: [], invoiceTextFound: false };
  const queue = files.map((f) => ({ ...f, parent: null as string | null }));
  let invoiceDoc: Extracted | null = null, emailDoc: Extracted | null = null;
  let primaryFile: { sha: string; artifact: string } | null = null;
  const docsForModel: Parameters<ModelProvider['extract']>[0][] = [];

  while (queue.length) {
    const f = queue.shift()!;
    const sha = sha256(f.bytes), artifactId = newId('art');
    let text = '', mime = 'application/octet-stream', kind = 'UNKNOWN';
    try {
      const s = sniff(f.bytes, f.filename);
      mime = s.mime; kind = s.kind;
      if (s.kind === 'PDF') {
        const r = await pdfToText(f.bytes);
        text = r.text; snap.signals.hiddenText.push(...r.tinyTextLines);
        docsForModel.push({ kind: 'PDF', mime, bytes: f.bytes });
      } else if (s.kind === 'IMAGE') {
        const r = await ocrImage(f.bytes);
        text = r.confidence >= 0.4 ? r.text : '';
        docsForModel.push({ kind: 'IMAGE', mime, bytes: f.bytes });
      } else if (s.kind === 'EMAIL') {
        const m = await parseEml(f.bytes);
        const { text: body, attachments, ...meta } = m;
        snap.email = meta; text = body;
        for (const a of attachments) queue.push({ filename: a.filename, bytes: a.bytes, parent: artifactId });
      } else text = Buffer.from(f.bytes).toString('utf8').slice(0, 200_000);
    } catch (e) {
      const message = e instanceof RejectedFile ? e.message : 'The file could not be read.';
      snap.rejectedFile = message;
      appendAudit(db, workspaceId, 'FILE_REJECTED', actor, requestId, { filename: f.filename.slice(0, 200), sha256: sha, reason: message });
    }
    run(db, 'INSERT INTO source_artifacts (id, workspace_id, payment_request_id, kind, filename, mime, size_bytes, sha256, parent_artifact_id, text_excerpt, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      artifactId, workspaceId, requestId, kind, f.filename.slice(0, 200), mime, f.bytes.length, sha, f.parent, text.slice(0, 6000), nowIso());
    appendAudit(db, workspaceId, 'FILE_INGESTED', actor, requestId, { artifact_id: artifactId, filename: f.filename.slice(0, 200), kind, sha256: sha, size_bytes: f.bytes.length });
    if (!text) continue;
    const signals = scanSignals(text);
    snap.signals.injection.push(...signals.injection); snap.signals.urgency.push(...signals.urgency);
    const parsed = parseInvoiceText(text);
    if (kind === 'EMAIL') emailDoc = parsed;
    else if (!invoiceDoc) { invoiceDoc = parsed; primaryFile = { sha, artifact: artifactId }; }
    else invoiceDoc = mergeDocs(invoiceDoc, parsed);
  }
  let merged = invoiceDoc && emailDoc ? mergeDocs(invoiceDoc, emailDoc) : invoiceDoc ?? emailDoc;
  if (!primaryFile && emailDoc && files[0]) primaryFile = { sha: sha256(files[0].bytes), artifact: '' };
  // Model extraction is independent and advisory. Its failure never makes a request safer.
  if (model.name !== 'none' && docsForModel.length) {
    try {
      const ai = await model.extract(docsForModel[0]);
      if (ai) {
        merged = mergeModelExtraction(merged ?? parseInvoiceText(''), ai, snap.fieldOrigins);
        snap.aiExtraction = true;
        snap.signals.injection.push(...ai.embedded_instructions.map((s) => s.slice(0, 220)));
      }
    } catch { snap.evidenceUnavailable.push('AI extraction'); }
  }
  snap.signals.injection = [...new Set(snap.signals.injection)].slice(0, 12);
  snap.signals.urgency = [...new Set(snap.signals.urgency)].slice(0, 12);
  snap.extraction = merged;
  snap.invoiceTextFound = Boolean(merged?.textLength);
  (snap as any).primaryFileSha = primaryFile?.sha ?? null;
  return snap;
}

/** Records the invoice, resolves vendor and destination, and stores the investigation snapshot. */
export async function investigate(ctx: Ctx, requestId: string, snap: Snapshot, actor: Actor, faults: Faults = {}) {
  const { db } = ctx;
  const req = one<any>(db, 'SELECT * FROM payment_requests WHERE id = ?', requestId)!;
  const ws = req.workspace_id as string;
  const e = snap.extraction;
  const evidence: Omit<EvidenceRow, 'id'>[] = [];
  const add = (x: Omit<EvidenceRow, 'id' | 'retrieved_at'>) => evidence.push({ ...x, retrieved_at: nowIso() });

  let vendors: any[] = [];
  try {
    if (faults.registryUnavailable) throw new Error('fault injected: trusted registry unavailable');
    vendors = all<any>(db, 'SELECT * FROM vendors WHERE workspace_id = ?', ws);
  } catch {
    snap.registryAvailable = false;
    snap.evidenceUnavailable.push('Trusted vendor registry');
    add({ source: 'Trusted vendor registry', claim: 'The vendor registry could not be consulted', stance: 'UNKNOWN', provenance: 'SYSTEM_COMPUTED', reliability: 'HIGH', confidence: null, limitations: 'Nothing can be verified against it until it returns.', artifact_hash: null, details: null });
  }

  // Resolve the vendor from an explicit selection, then the document name, then the sender's domain.
  const invoiceName = e?.vendorName.value ?? null;
  const fromDomain = domainOf(snap.email?.from ?? null);
  let vendor = req.vendor_id ? vendors.find((v) => v.id === req.vendor_id) : undefined;
  if (!vendor && invoiceName) vendor = vendors.find((v) => v.normalized_name === normalizeName(invoiceName));
  if (!vendor && snap.email?.fromName) vendor = vendors.find((v) => v.normalized_name === normalizeName(snap.email!.fromName!));
  if (!vendor && fromDomain) vendor = vendors.find((v) => J(v.domains, []).some((d: string) => isSameOrSubdomain(fromDomain, d)));

  // Invoice record and fingerprints.
  const total = e?.total.status === 'FOUND' ? e.total.value : null;
  const currency = e?.currency.status === 'FOUND' ? e.currency.value : null;
  const number = e?.invoiceNumber.status === 'FOUND' ? e.invoiceNumber.value : null;
  const fileSha = (snap as any).primaryFileSha as string | null;
  let invoiceId: string | null = req.invoice_id;
  if (e && !invoiceId) {
    invoiceId = newId('inv');
    const norm = number ? normalizeInvoiceNumber(number) : null;
    const nameKey = normalizeName(vendor?.name ?? invoiceName ?? '');
    const semantic = sha256(JSON.stringify([nameKey, total, currency, (e.invoiceDate.value ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''), e.lineItems.map((l) => [l.description.toLowerCase().replace(/\s+/g, ' ').trim(), l.amountMinor])]));
    run(db, `INSERT INTO invoices (id, workspace_id, payment_request_id, vendor_id, vendor_name, number, normalized_number, invoice_date, due_date, currency, total_minor, subtotal_minor, tax_minor, purchase_order, file_fingerprint, semantic_fingerprint, extraction, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, invoiceId, ws, requestId, vendor?.id ?? null, invoiceName, number, norm, e.invoiceDate.value, e.dueDate.value, currency, total, e.subtotal.value, e.tax.value, e.purchaseOrder.value, fileSha, semantic, JSON.stringify(e), nowIso());
    for (const l of e.lineItems) run(db, 'INSERT INTO invoice_line_items (id, workspace_id, invoice_id, description, quantity, unit_price_minor, amount_minor) VALUES (?,?,?,?,?,?,?)', newId('li'), ws, invoiceId, l.description.slice(0, 300), l.quantity, l.unitPriceMinor, l.amountMinor);
  }

  // Destination: what the request or the document asks to be paid.
  const trusted = vendor ? all<any>(db, `SELECT * FROM vendor_destinations WHERE vendor_id = ? AND status = 'VERIFIED'`, vendor.id) : [];
  const asked = [
    ...(req.destination_value ? [{ type: req.destination_type, value: req.destination_value, source: 'payment request' }] : []),
    ...(e?.destinations ?? []),
  ];
  const seen = new Set<string>();
  const askedUnique = asked.filter((d) => { const f = destinationFingerprint(d.type, d.value); if (seen.has(f)) return false; seen.add(f); return true; });
  const untrustedAsked = askedUnique.filter((d) => !trusted.some((t) => t.fingerprint === destinationFingerprint(d.type, d.value)));
  // The money only ever goes to a matched destination from the registry, never to a string from a document.
  const matched = askedUnique.length ? trusted.find((t) => askedUnique.some((d) => t.fingerprint === destinationFingerprint(d.type, d.value))) : trusted[0];
  const finalDest = untrustedAsked.length ? untrustedAsked[0] : matched ? { type: matched.type, value: matched.value } : askedUnique[0] ?? null;

  const amountMinor = req.amount_minor ?? total;
  const finalCurrency = req.currency ?? currency;
  run(db, `UPDATE payment_requests SET vendor_id = ?, payee_name = COALESCE(payee_name, ?), invoice_id = ?, amount_minor = ?, currency = ?, destination_type = ?, destination_value = ?, destination_fingerprint = ?, updated_at = ? WHERE id = ?`,
    vendor?.id ?? null, invoiceName ?? snap.email?.fromName ?? null, invoiceId, amountMinor, finalCurrency, finalDest?.type ?? null, finalDest?.value ?? null, finalDest ? destinationFingerprint(finalDest.type, finalDest.value) : null, nowIso(), requestId);
  if (e) appendAudit(db, ws, 'FIELDS_EXTRACTED', actor, requestId, { method: e.method, vendor: invoiceName, invoice_number: number, total_minor: total, currency, destinations: e.destinations.length, unknown: Object.entries(e).filter(([, v]: any) => v?.status === 'UNKNOWN').map(([k]) => k) });

  // Evidence: registry.
  if (vendor) {
    add({ source: 'Trusted vendor registry', claim: `${vendor.name} is in your directory with status ${vendor.status.toLowerCase()}`, stance: vendor.status === 'VERIFIED' ? 'SUPPORTS' : 'CONTRADICTS', provenance: 'TRUSTED_REGISTRY', reliability: 'HIGH', confidence: 1, limitations: null, artifact_hash: null, details: JSON.stringify({ vendor_id: vendor.id }) });
    for (const d of askedUnique) {
      const ok = trusted.some((t) => t.fingerprint === destinationFingerprint(d.type, d.value));
      add({ source: `Invoice ${d.source}, compared with registry`, claim: `${label(d.type)} ${d.value} ${ok ? 'matches a verified destination' : 'is not a verified destination for this vendor'}`, stance: ok ? 'SUPPORTS' : 'CONTRADICTS', provenance: 'TRUSTED_REGISTRY', reliability: 'HIGH', confidence: 1, limitations: null, artifact_hash: null, details: JSON.stringify({ asked: d.value, verified: trusted.map((t) => t.value) }) });
    }
    if (!askedUnique.length && trusted.length) add({ source: 'Trusted vendor registry', claim: 'The document names no destination, so payment would go to the verified destination on file', stance: 'SUPPORTS', provenance: 'TRUSTED_REGISTRY', reliability: 'HIGH', confidence: 1, limitations: null, artifact_hash: null, details: null });
  } else if (snap.registryAvailable) {
    add({ source: 'Trusted vendor registry', claim: `No vendor named “${invoiceName ?? 'unknown'}” is in your directory`, stance: 'CONTRADICTS', provenance: 'TRUSTED_REGISTRY', reliability: 'HIGH', confidence: 1, limitations: null, artifact_hash: null, details: null });
  }

  // Evidence: history.
  if (vendor) {
    const hist = all<any>(db, `SELECT number, total_minor, currency, is_seed_history FROM invoices WHERE vendor_id = ? AND id <> ? AND total_minor IS NOT NULL ORDER BY created_at DESC LIMIT 12`, vendor.id, invoiceId ?? '');
    if (hist.length) {
      const max = Math.max(...hist.map((h) => h.total_minor));
      add({ source: 'Your invoice history', claim: `${hist.length} earlier invoices from this vendor; the largest was ${formatMinor(max, hist[0].currency ?? 'USD')}`, stance: total !== null && total > max * 3 ? 'CONTRADICTS' : 'SUPPORTS', provenance: 'HISTORY', reliability: 'HIGH', confidence: 1, limitations: hist.some((h) => h.is_seed_history) ? 'Includes seeded demo history.' : null, artifact_hash: null, details: JSON.stringify(hist.slice(0, 6)) });
    } else add({ source: 'Your invoice history', claim: 'No earlier invoices from this vendor', stance: 'UNKNOWN', provenance: 'HISTORY', reliability: 'HIGH', confidence: 1, limitations: null, artifact_hash: null, details: null });
  }

  // Evidence: sender.
  if (snap.email) {
    const m = snap.email;
    const domains: string[] = vendor ? J(vendor.domains, []) : [];
    const trustedDomain = fromDomain ? domains.some((d) => isSameOrSubdomain(fromDomain, d)) : false;
    add({ source: 'Email headers', claim: `Sent from ${m.from ?? 'an unknown address'}${vendor ? (trustedDomain ? `, a verified domain for ${vendor.name}` : `, not a verified domain for ${vendor.name}`) : ''}`, stance: trustedDomain ? 'SUPPORTS' : vendor ? 'CONTRADICTS' : 'NEUTRAL', provenance: 'USER_PROVIDED', reliability: 'MEDIUM', confidence: null, limitations: 'A From header can be forged. A match is supporting evidence, not proof.', artifact_hash: null, details: JSON.stringify({ from: m.from, reply_to: m.replyTo, return_path: m.returnPath, trusted_domains: domains }) });
    if (m.authenticationResults.present) add({ source: 'Authentication-Results header', claim: `SPF ${m.authenticationResults.spf ?? 'absent'}, DKIM ${m.authenticationResults.dkim ?? 'absent'}, DMARC ${m.authenticationResults.dmarc ?? 'absent'}`, stance: [m.authenticationResults.spf, m.authenticationResults.dkim, m.authenticationResults.dmarc].some((v) => v === 'fail') ? 'CONTRADICTS' : 'NEUTRAL', provenance: 'USER_PROVIDED', reliability: 'LOW', confidence: null, limitations: 'Uploaded headers can be edited. Failures count against the sender; passes earn no trust.', artifact_hash: null, details: null });
  }

  // Evidence: public corroboration. Never verification.
  const domainForPublic = fromDomain ?? (vendor ? J(vendor.domains, [])[0] : null) ?? e?.emails.map((x) => domainOf(x)).find(Boolean) ?? null;
  if (domainForPublic) {
    const pub = await ctx.publicEvidence(domainForPublic).catch(() => null);
    snap.publicEvidence = pub;
    if (!pub || !pub.available) {
      snap.evidenceUnavailable.push('Public domain lookup');
      add({ source: 'Public DNS and RDAP', claim: `Public records for ${domainForPublic} could not be retrieved`, stance: 'UNKNOWN', provenance: 'PUBLIC_SOURCE', reliability: 'LOW', confidence: null, limitations: 'Public lookups are corroboration only, so this does not change the decision.', artifact_hash: null, details: null });
    } else if (pub.reservedTestDomain) {
      add({ source: 'Public DNS and RDAP', claim: `${domainForPublic} is a reserved test domain, so no public lookup was made`, stance: 'NEUTRAL', provenance: 'PUBLIC_SOURCE', reliability: 'LOW', confidence: null, limitations: 'Seeded scenarios use reserved domains so they stay reproducible.', artifact_hash: null, details: null });
    } else {
      add({ source: 'Public DNS and RDAP', claim: `${domainForPublic}: ${pub.ageDays !== null ? `registered ${pub.ageDays} days ago` : 'registration date unknown'}, mail records ${pub.hasMx ? 'present' : 'absent'}, DMARC ${pub.hasDmarc ? 'present' : 'absent'}`, stance: pub.ageDays !== null && pub.ageDays < 90 ? 'CONTRADICTS' : 'NEUTRAL', provenance: 'PUBLIC_SOURCE', reliability: 'LOW', confidence: null, limitations: 'Corroboration only. A website or domain never verifies a payee.', artifact_hash: null, details: JSON.stringify(pub) });
      if (pub.homepage?.injection.length) { snap.signals.websiteInjection.push(...pub.homepage.injection.slice(0, 5)); add({ source: `Homepage of ${domainForPublic}`, claim: 'The website contains text addressed to AI systems', stance: 'CONTRADICTS', provenance: 'PUBLIC_SOURCE', reliability: 'LOW', confidence: null, limitations: 'The text was treated as data and ignored.', artifact_hash: null, details: JSON.stringify(pub.homepage.injection.slice(0, 5)) }); }
    }
  }

  // Evidence: document signals.
  if (snap.signals.injection.length) add({ source: 'Document text scan', claim: 'The document contains text aimed at software or AI reviewers', stance: 'CONTRADICTS', provenance: 'SYSTEM_COMPUTED', reliability: 'HIGH', confidence: null, limitations: 'Ignored as an instruction. Recorded as evidence.', artifact_hash: fileSha, details: JSON.stringify(snap.signals.injection) });
  if (snap.signals.hiddenText.length) add({ source: 'Document layout scan', claim: `${snap.signals.hiddenText.length} line(s) of near-invisible text found`, stance: 'CONTRADICTS', provenance: 'SYSTEM_COMPUTED', reliability: 'MEDIUM', confidence: null, limitations: null, artifact_hash: fileSha, details: JSON.stringify(snap.signals.hiddenText.slice(0, 5)) });
  if (snap.signals.urgency.length) add({ source: 'Message wording scan', claim: 'The message pressures for speed, secrecy or new payment details', stance: 'CONTRADICTS', provenance: 'SYSTEM_COMPUTED', reliability: 'MEDIUM', confidence: null, limitations: 'Wording alone proves nothing.', artifact_hash: fileSha, details: JSON.stringify(snap.signals.urgency) });
  const totalsState = checkTotals(e);
  if (e) add({ source: 'Invoice arithmetic', claim: totalsState === 'CONSISTENT' ? 'Line items, tax and total add up' : totalsState === 'CONFLICT' ? 'Line items, tax and total do not add up, or totals disagree' : 'There is not enough detail to check the arithmetic', stance: totalsState === 'CONSISTENT' ? 'SUPPORTS' : totalsState === 'CONFLICT' ? 'CONTRADICTS' : 'UNKNOWN', provenance: 'SYSTEM_COMPUTED', reliability: 'HIGH', confidence: 1, limitations: null, artifact_hash: fileSha, details: e.total.candidates ? JSON.stringify(e.total.candidates) : null });

  // Model review: advisory only. Its text is displayed and counted; it is never parsed for verdicts.
  if (ctx.model.name !== 'none' && e) {
    try {
      const prompt = `<system_computed>${JSON.stringify({ vendor_in_directory: vendor?.name ?? null, vendor_status: vendor?.status ?? null, destination_matches_registry: !untrustedAsked.length && Boolean(matched), totals: totalsState })}</system_computed>\n<untrusted>\n${JSON.stringify({ email: snap.email, extraction: e, text: all<any>(db, 'SELECT text_excerpt FROM source_artifacts WHERE payment_request_id = ?', requestId).map((a) => a.text_excerpt) })}\n</untrusted>`;
      const inv = await ctx.model.investigate(prompt);
      if (inv) {
        const serious = inv.concerns.filter((c) => c.severity !== 'LOW');
        snap.modelConcerns = serious.length;
        run(db, 'UPDATE payment_requests SET summary = ? WHERE id = ?', inv.summary.slice(0, 1000), requestId);
        for (const c of inv.concerns.slice(0, 8)) add({ source: `AI investigator (${ctx.model.name})`, claim: c.title.slice(0, 200), stance: 'NEUTRAL', provenance: 'MODEL_INFERRED', reliability: 'LOW', confidence: null, limitations: 'Model inference. Not a verified fact. It can only raise a decision to review.', artifact_hash: null, details: JSON.stringify({ explanation: c.explanation.slice(0, 800), severity: c.severity }) });
        (snap as any).recommendedSteps = inv.recommended_steps.slice(0, 6).map((s) => s.slice(0, 300));
      }
    } catch { snap.evidenceUnavailable.push('AI investigator'); }
  }

  const bundleId = newId('bun');
  for (const ev of evidence) run(db, `INSERT INTO evidence_items (id, workspace_id, payment_request_id, bundle_id, source, retrieved_at, claim, stance, provenance, reliability, confidence, limitations, artifact_hash, details) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    newId('ev'), ws, requestId, bundleId, ev.source, ev.retrieved_at, ev.claim, ev.stance, ev.provenance, ev.reliability, ev.confidence, ev.limitations, ev.artifact_hash, ev.details);
  run(db, 'UPDATE payment_requests SET evidence_bundle_id = ?, facts = ? WHERE id = ?', bundleId, JSON.stringify(snap), requestId);
  appendAudit(db, ws, 'EVIDENCE_RETRIEVED', actor, requestId, { bundle_id: bundleId, items: evidence.length, unavailable: snap.evidenceUnavailable });
}
type EvidenceRow = { id: string; source: string; retrieved_at: string; claim: string; stance: string; provenance: string; reliability: string; confidence: number | null; limitations: string | null; artifact_hash: string | null; details: string | null };
const label = (t: string) => ({ PAYPAL_EMAIL: 'PayPal account', IBAN: 'IBAN', BANK_ACCOUNT: 'Bank account', OTHER: 'Destination' } as Record<string, string>)[t] ?? t;

/** Builds the facts for the policy engine from current database state plus the stored document snapshot. */
export function buildFacts(db: DB, requestId: string, opts: { ownAttemptId?: string } = {}): { facts: Facts; tte: TTE; policy: ReturnType<typeof currentPolicy>; invoice: any } {
  const req = one<any>(db, 'SELECT * FROM payment_requests WHERE id = ?', requestId)!;
  const ws = req.workspace_id as string;
  const policy = currentPolicy(db, ws);
  const snap: Snapshot = J(req.facts, null) ?? { extraction: null, signals: { injection: [], urgency: [], hiddenText: [], websiteInjection: [] }, modelConcerns: 0, rejectedFile: null, registryAvailable: true, evidenceUnavailable: [], email: null, fieldOrigins: {}, aiExtraction: false, publicEvidence: null, invoiceTextFound: false };
  const e = snap.extraction;
  const vendor = req.vendor_id ? one<any>(db, 'SELECT * FROM vendors WHERE id = ? AND workspace_id = ?', req.vendor_id, ws) : null;
  const invoice = req.invoice_id ? one<any>(db, 'SELECT * FROM invoices WHERE id = ?', req.invoice_id) : null;
  const artifactRows = all<any>(db, 'SELECT id, sha256 FROM source_artifacts WHERE payment_request_id = ? AND parent_artifact_id IS NULL', requestId);
  const artifacts = artifactRows.map((a) => a.id);
  const trusted = vendor ? all<any>(db, `SELECT * FROM vendor_destinations WHERE vendor_id = ? AND status = 'VERIFIED'`, vendor.id) : [];
  const allVendors = all<any>(db, 'SELECT * FROM vendors WHERE workspace_id = ?', ws);

  // Agent authority, always re-read from current state.
  let agentFacts: Facts['agent'] = null;
  if (req.origin === 'AGENT') {
    const check: AgentCheck = J(req.agent_check, { registered: false, signature: 'MISSING', grantFormat: 'MISSING', replayedNonce: false, authorizationId: null, authorizationVersion: null });
    const agent = req.agent_id ? one<any>(db, 'SELECT * FROM agents WHERE id = ? AND workspace_id = ?', req.agent_id, ws) : null;
    const grant = check.authorizationId ? one<any>(db, 'SELECT * FROM agent_authorizations WHERE id = ? AND workspace_id = ?', check.authorizationId, ws) : null;
    let g: NonNullable<Facts['agent']>['grant'] = check.grantFormat;
    if (g === 'VALID') {
      if (!grant || grant.agent_id !== req.agent_id) g = 'FORGED';
      else if (grant.status === 'REVOKED') g = 'REVOKED';
      else if (grant.status === 'SUPERSEDED') g = 'SUPERSEDED';
      else if (Date.parse(grant.expires_at) <= Date.now()) g = 'EXPIRED';
    }
    const amt = req.amount_minor as number | null;
    const spend = req.agent_id && req.currency ? agentSpend(db, req.agent_id, req.currency, requestId) : { day: 0, month: 0 };
    agentFacts = {
      registered: Boolean(agent), active: agent?.status === 'ACTIVE', signature: check.signature, grant: g, replayedNonce: check.replayedNonce,
      amountInScope: grant ? amt !== null && amt <= grant.per_tx_max_minor : false,
      categoryInScope: grant ? J(grant.categories, []).includes(req.category) : false,
      vendorInScope: grant ? Boolean(req.vendor_id) && J(grant.vendor_ids, []).includes(req.vendor_id) : false,
      currencyInScope: grant ? J(grant.currencies, []).includes(req.currency) : false,
      actionInScope: grant ? J(grant.actions, []).includes('PAYMENT_REQUEST') : false,
      dailyBudgetOk: grant ? spend.day + (amt ?? 0) <= grant.daily_budget_minor : false,
      monthlyBudgetOk: grant ? spend.month + (amt ?? 0) <= grant.monthly_budget_minor : false,
      grantPolicyVersionCurrent: grant ? grant.policy_version === policy.version : false,
    };
  }

  // Destination.
  const askedList: { type: string; value: string }[] = [...(e?.destinations ?? []), ...(req.destination_value ? [{ type: req.destination_type, value: req.destination_value }] : [])];
  const fps = new Set(askedList.map((d) => destinationFingerprint(d.type, d.value)));
  const trustedFps = new Set(trusted.map((t) => t.fingerprint));
  const untrusted = [...fps].filter((f) => !trustedFps.has(f));
  let destStatus: Facts['destination']['status'];
  if (!vendor) destStatus = fps.size ? 'NO_TRUSTED_RECORD' : 'MISSING';
  else if (!trusted.length) destStatus = fps.size ? 'NO_TRUSTED_RECORD' : 'MISSING';
  else destStatus = untrusted.length ? 'MISMATCH' : req.destination_fingerprint && trustedFps.has(req.destination_fingerprint) ? 'MATCH' : 'MISSING';

  // Sender.
  const domains: string[] = vendor ? J(vendor.domains, []) : [];
  const fromDomain = domainOf(snap.email?.from ?? null), replyDomain = domainOf(snap.email?.replyTo ?? null);
  const compare = vendor ? domains : allVendors.flatMap((v) => J(v.domains, []) as string[]);
  const domainStatus: Facts['sender']['domain'] = !fromDomain ? 'NONE' : vendor && domains.some((d) => isSameOrSubdomain(fromDomain, d)) ? 'TRUSTED' : compare.some((d) => isLookalike(fromDomain, d)) ? 'LOOKALIKE' : 'UNRECOGNIZED';
  const replyStatus: Facts['sender']['replyTo'] = !replyDomain ? 'NONE' : replyDomain === fromDomain || domains.some((d) => isSameOrSubdomain(replyDomain, d)) ? 'MATCH' : 'MISMATCH';
  const ar = snap.email?.authenticationResults;

  // Vendor name.
  const invName = invoice?.vendor_name as string | null;
  const nameMismatch = Boolean(vendor && invName && normalizeName(invName) !== vendor.normalized_name && !nameResembles(normalizeName(invName), vendor.normalized_name));
  const resemblesMatch = (!vendor || (invName && normalizeName(invName) !== vendor.normalized_name)) && invName ? allVendors.find((v) => nameResembles(normalizeName(invName), v.normalized_name)) : null;

  // Duplicates, excluding this request's own records.
  const num = invoice?.normalized_number, sem = invoice?.semantic_fingerprint, file = invoice?.file_fingerprint, invId = invoice?.id ?? '';
  const others = (where: string, ...p: any[]) => Boolean(one(db, `SELECT 1 FROM invoices i LEFT JOIN payment_requests r ON r.id = i.payment_request_id WHERE i.workspace_id = ? AND i.id <> ? AND (r.status IS NULL OR r.status NOT IN ('REJECTED', 'DENIED')) AND ${where} LIMIT 1`, ws, invId, ...p));
  const sameVendorClause = vendor ? 'i.vendor_id = ?' : 'i.vendor_name = ?';
  const vendorKey = vendor?.id ?? invName ?? '';
  const paidOrFlying = (statuses: string, excludeOwn: boolean) => {
    if (!invoice) return false;
    const own = excludeOwn ? `AND a.id <> '${(opts.ownAttemptId ?? '').replace(/'/g, '')}'` : '';
    const byInvoice = one(db, `SELECT 1 FROM payment_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE a.workspace_id = ? AND a.status IN (${statuses}) ${own} AND ${sameVendorClause} AND ((? IS NOT NULL AND i.normalized_number = ?) OR i.semantic_fingerprint = ?) LIMIT 1`, ws, vendorKey, num ?? null, num ?? null, sem ?? '');
    return Boolean(byInvoice);
  };
  const ownAttempt = one(db, `SELECT 1 FROM payment_attempts WHERE payment_request_id = ? AND status <> 'FAILED' ${opts.ownAttemptId ? `AND id <> '${opts.ownAttemptId.replace(/'/g, '')}'` : ''} LIMIT 1`, requestId);
  const alreadyPaid = paidOrFlying(`'COMPLETED'`, false);
  const flying = Boolean(ownAttempt) || paidOrFlying(`'CREATED','APPROVED','CAPTURE_PENDING','UNKNOWN'`, true);

  // History.
  // History counts only invoices that were actually paid, so untrusted submissions cannot shift the baseline.
  const maxHist = vendor ? one<{ m: number | null }>(db, `SELECT MAX(i.total_minor) m FROM invoices i WHERE i.vendor_id = ? AND i.id <> ? AND EXISTS (SELECT 1 FROM payment_attempts a WHERE a.invoice_id = i.id AND a.status = 'COMPLETED')`, vendor.id, invId)?.m ?? null : null;

  // Critical unknowns. Unknown is never safe.
  const criticalUnknown: string[] = [];
  const hasInvoiceDoc = Boolean(e);
  if (hasInvoiceDoc) {
    if (e!.total.status === 'UNKNOWN') criticalUnknown.push('total amount');
    if (e!.currency.status === 'UNKNOWN') criticalUnknown.push('currency');
    if (e!.invoiceNumber.status === 'UNKNOWN') criticalUnknown.push('invoice number');
    if (e!.vendorName.status === 'UNKNOWN' && !vendor) criticalUnknown.push('vendor');
  } else {
    if (artifacts.length) criticalUnknown.push('invoice details (the file could not be read)');
    if (req.amount_minor === null) criticalUnknown.push('total amount');
  }
  if (!req.currency && !criticalUnknown.includes('currency')) criticalUnknown.push('currency');
  const conflicts = e ? (['vendorName', 'invoiceNumber', 'currency', 'invoiceDate'] as const).filter((k) => e[k].status === 'CONFLICT').map((k) => ({ vendorName: 'vendor name', invoiceNumber: 'invoice number', currency: 'currency', invoiceDate: 'invoice date' }[k])) : [];
  const totals = checkTotals(e);
  const amountDiffers = Boolean(e && e.total.status === 'FOUND' && req.amount_minor !== null && e.total.value !== req.amount_minor);

  // Approvals bound to this exact transaction.
  const tte: TTE = {
    transaction_id: requestId, workspace_id: ws, revision: req.revision, principal_id: req.principal_id ?? null, agent_id: req.agent_id ?? null,
    authorization_id: req.authorization_id ?? null, authorization_version: req.authorization_version ?? null, payee_id: req.vendor_id ?? null,
    payee_destination_fingerprint: req.destination_fingerprint ?? null, invoice_id: req.invoice_id ?? null, invoice_fingerprint: sem ?? null,
    amount_minor_units: req.amount_minor ?? null, currency: req.currency ?? null, category: req.category ?? null, source_artifact_ids: artifacts, policy_version: policy.version, rail: req.rail,
  };
  const fp = transactionFingerprint(tte);
  const approvals = all<any>(db, 'SELECT * FROM approvals WHERE payment_request_id = ? AND invalidated_at IS NULL', requestId);
  const facts: Facts = {
    origin: req.origin, agent: agentFacts,
    vendor: {
      status: vendor?.status ?? 'UNKNOWN',
      currencyApproved: vendor ? !req.currency || J(vendor.currencies, []).includes(req.currency) : false,
      categoryApproved: vendor ? !req.category || !J(vendor.categories, []).length || J(vendor.categories, []).includes(req.category) : false,
      nameMismatch, resembles: resemblesMatch?.name ?? null,
    },
    destination: { status: destStatus, railSupported: req.destination_type === 'PAYPAL_EMAIL' },
    sender: { present: Boolean(snap.email), domain: domainStatus, replyTo: replyStatus, authFailed: Boolean(ar && [ar.spf, ar.dkim, ar.dmarc].some((v) => v === 'fail')) },
    extraction: { criticalUnknown, conflicts: conflicts as string[], totals, maliciousFile: Boolean(snap.rejectedFile), modelOnly: Object.entries(snap.fieldOrigins ?? {}).filter(([, v]) => v === 'MODEL_ONLY').map(([k]) => k), amountDiffersFromInvoice: amountDiffers },
    duplicates: {
      alreadyPaid, paymentInFlight: flying,
      exactFile: (file ? others('i.file_fingerprint = ?', file) : false) || artifactRows.some((a) => Boolean(one(db, `SELECT 1 FROM source_artifacts s JOIN payment_requests r ON r.id = s.payment_request_id WHERE s.workspace_id = ? AND s.sha256 = ? AND s.payment_request_id <> ? AND r.status NOT IN ('REJECTED', 'DENIED') LIMIT 1`, ws, a.sha256, requestId))),
      repeatWithoutInvoice: !invoice && Boolean(vendor) && req.amount_minor !== null && Boolean(one(db, `SELECT 1 FROM payment_attempts WHERE workspace_id = ? AND vendor_id = ? AND amount_minor = ? AND currency = ? AND status <> 'FAILED' AND (payment_request_id IS NULL OR payment_request_id <> ?) AND created_at >= ? LIMIT 1`, ws, vendor?.id, req.amount_minor, req.currency, requestId, new Date(Date.now() - 30 * 86_400_000).toISOString())),
      sameNumber: num ? others(`i.normalized_number = ? AND ${sameVendorClause}`, num, vendorKey) : false,
      semantic: sem ? others(`i.semantic_fingerprint = ?`, sem) : false,
    },
    amount: { minor: req.amount_minor ?? null, currency: req.currency ?? null, maxHistoricalMinor: maxHist, purchaseOrderPresent: Boolean(invoice?.purchase_order) },
    signals: { injection: snap.signals.injection.length + snap.signals.hiddenText.length, urgency: snap.signals.urgency.length, modelFindings: snap.modelConcerns ?? 0, websiteInjection: snap.signals.websiteInjection.length },
    evidence: { registryAvailable: snap.registryAvailable, unavailable: snap.evidenceUnavailable },
    approval: {
      valid: approvals.some((a) => a.action === 'APPROVE' && a.transaction_fingerprint === fp && a.policy_version === policy.version),
      reviewedCodes: approvals.filter((a) => a.action === 'APPROVE' && a.transaction_fingerprint === fp).flatMap((a) => J(a.reviewed_codes, [])),
      stale: approvals.some((a) => a.transaction_fingerprint !== fp),
      rejected: approvals.some((a) => a.action === 'REJECT' && a.transaction_fingerprint === fp),
    },
    lifecycle: { expired: Date.parse(req.expires_at) <= Date.now() },
  };
  return { facts, tte, policy, invoice };
}

export const decisionSignature = (key: string, d: { id: string; workspace_id: string; payment_request_id: string; revision: number; transaction_fingerprint: string; decision: string; policy_version: number; expires_at: string }) =>
  hmac(key, JSON.stringify([d.id, d.workspace_id, d.payment_request_id, d.revision, d.transaction_fingerprint, d.decision, d.policy_version, d.expires_at]));

const STATUS_FOR: Record<string, string> = { ALLOW: 'READY_FOR_CONFIRMATION', REVIEW: 'AWAITING_REVIEW', HOLD: 'ON_HOLD', DENY: 'DENIED' };

/** Runs the engine and records a signed decision. Earlier decisions for this request are superseded. */
export function evaluateAndRecord(ctx: Ctx, requestId: string, actor: Actor) {
  const { db, decisionKey } = ctx;
  return tx(db, () => {
    const { facts, tte, policy } = buildFacts(db, requestId);
    const result: Evaluation = evaluate(facts, policy.rules);
    const fp = transactionFingerprint(tte);
    const req = one<any>(db, 'SELECT * FROM payment_requests WHERE id = ?', requestId)!;
    const ws = req.workspace_id;
    run(db, 'UPDATE policy_decisions SET superseded = 1 WHERE payment_request_id = ?', requestId);
    const d = { id: newId('dec'), workspace_id: ws, payment_request_id: requestId, revision: req.revision, transaction_fingerprint: fp, decision: result.decision, policy_version: policy.version, expires_at: new Date(Date.now() + policy.rules.decisionTtlMinutes * 60_000).toISOString() };
    const signature = decisionSignature(decisionKey, d);
    run(db, `INSERT INTO policy_decisions (id, workspace_id, payment_request_id, revision, transaction_fingerprint, decision, reasons, policy_version, facts, signature, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      d.id, ws, requestId, d.revision, fp, d.decision, JSON.stringify({ reasons: result.reasons, satisfiedByApproval: result.satisfiedByApproval, rulesChecked: result.rulesChecked, tte }), d.policy_version, JSON.stringify(facts), signature, nowIso(), d.expires_at);

    // Findings mirror the rules that fired, so the explanation and the decision can never diverge.
    const bundle = req.evidence_bundle_id ?? 'none';
    run(db, `DELETE FROM risk_findings WHERE payment_request_id = ? AND source = 'RULE'`, requestId);
    const sev: Record<string, string> = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' };
    for (const r of result.reasons) run(db, `INSERT INTO risk_findings (id, workspace_id, payment_request_id, bundle_id, code, severity, title, explanation, source) VALUES (?,?,?,?,?,?,?,?, 'RULE')`, newId('fnd'), ws, requestId, bundle, r.code, sev[r.severity], r.code, r.message);

    // Approval requests track the decision.
    run(db, `UPDATE approval_requests SET status = 'INVALIDATED' WHERE payment_request_id = ? AND status = 'OPEN'`, requestId);
    if (result.decision === 'REVIEW') run(db, `INSERT INTO approval_requests (id, workspace_id, payment_request_id, decision_id, transaction_fingerprint, reasons, status, created_at) VALUES (?,?,?,?,?,?, 'OPEN', ?)`, newId('apr'), ws, requestId, d.id, fp, JSON.stringify(result.reasons.filter((r) => r.approvable && !result.satisfiedByApproval.includes(r.code))), nowIso());

    if (!['COMPLETED', 'PAYMENT_PENDING', 'EXECUTING', 'REJECTED'].includes(req.status)) setStatus(db, requestId, STATUS_FOR[result.decision]);
    appendAudit(db, ws, 'POLICY_DECISION', actor, requestId, { decision_id: d.id, decision: d.decision, policy_version: d.policy_version, transaction_fingerprint: fp, rules_fired: result.reasons.map((r) => r.code), satisfied_by_approval: result.satisfiedByApproval });
    return { decisionId: d.id, decision: result.decision, reasons: result.reasons, fingerprint: fp };
  });
}

/** The single entry point for scenarios and uploads alike: extract, investigate, decide. */
export async function analyze(ctx: Ctx, requestId: string, files: Upload[], actor: Actor, faults: Faults = {}) {
  const { db } = ctx;
  const ws = one<any>(db, 'SELECT workspace_id FROM payment_requests WHERE id = ?', requestId)!.workspace_id;
  setStatus(db, requestId, 'EXTRACTING');
  const snap = await ingest(ctx, requestId, ws, files, actor);
  setStatus(db, requestId, 'INVESTIGATING');
  await investigate(ctx, requestId, snap, actor, faults);
  setStatus(db, requestId, 'EVALUATED');
  const out = evaluateAndRecord(ctx, requestId, actor);
  return out;
}

export function latestDecision(db: DB, requestId: string) {
  return one<any>(db, 'SELECT * FROM policy_decisions WHERE payment_request_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', requestId);
}

export class Forbidden extends Error { status = 403; }
export class Conflict extends Error { status = 409; }

/** A person approves or rejects one exact transaction. The client must echo the fingerprint it was shown. */
export function recordApproval(ctx: Ctx, requestId: string, user: { id: string; role: string }, input: { action: 'APPROVE' | 'REJECT'; fingerprint: string; comment?: string }) {
  const { db } = ctx;
  const out = tx(db, () => {
    if (!['OWNER', 'FINANCE_ADMIN'].includes(user.role)) throw new Forbidden('Your role cannot approve payments. Ask an owner or finance admin.');
    const req = one<any>(db, 'SELECT * FROM payment_requests WHERE id = ?', requestId)!;
    const { facts, tte, policy, invoice } = buildFacts(db, requestId);
    const fp = transactionFingerprint(tte);
    if (fp !== input.fingerprint) throw new Conflict('This transaction changed after you viewed it. Review the new details.');
    const d = latestDecision(db, requestId);
    if (!d || d.decision !== 'REVIEW' || d.transaction_fingerprint !== fp) throw new Conflict('This request is not waiting for review.');
    if (input.action === 'APPROVE' && policy.rules.separationOfDuties && req.submitted_by === user.id) throw new Forbidden('You submitted this request, so someone else must approve it. Switch to another finance user.');
    const ar = one<any>(db, `SELECT * FROM approval_requests WHERE payment_request_id = ? AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1`, requestId);
    if (!ar) throw new Conflict('There is no open approval request.');
    const reviewed = J(ar.reasons, []).map((r: any) => r.code);
    run(db, `INSERT INTO approvals (id, workspace_id, approval_request_id, payment_request_id, approver_user_id, action, transaction_fingerprint, amount_minor, currency, destination_fingerprint, invoice_fingerprint, policy_version, reviewed_codes, comment, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      newId('apv'), req.workspace_id, ar.id, requestId, user.id, input.action, fp, req.amount_minor, req.currency, req.destination_fingerprint, invoice?.semantic_fingerprint ?? null, policy.version, JSON.stringify(reviewed), input.comment?.slice(0, 1000) ?? null, nowIso());
    run(db, `UPDATE approval_requests SET status = ? WHERE id = ?`, input.action === 'APPROVE' ? 'APPROVED' : 'REJECTED', ar.id);
    appendAudit(db, req.workspace_id, input.action === 'APPROVE' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED', { type: 'USER', id: user.id }, requestId, { transaction_fingerprint: fp, amount_minor: req.amount_minor, currency: req.currency, policy_version: policy.version, comment: input.comment?.slice(0, 200) ?? null });
    if (input.action === 'REJECT') setStatus(db, requestId, 'REJECTED');
    return facts;
  });
  return input.action === 'APPROVE' ? evaluateAndRecord(ctx, requestId, { type: 'USER', id: user.id }) : (evaluateAndRecord(ctx, requestId, { type: 'USER', id: user.id }), { decision: 'DENY' as const });
}

/** Any material change creates a new revision: prior approvals and decisions no longer apply. */
export function amendRequest(ctx: Ctx, requestId: string, actor: Actor, change: { amount_minor?: number; currency?: string; destination_type?: string; destination_value?: string; vendor_id?: string; category?: string }) {
  const { db } = ctx;
  tx(db, () => {
    const req = one<any>(db, 'SELECT * FROM payment_requests WHERE id = ?', requestId)!;
    if (['EXECUTING', 'PAYMENT_PENDING', 'COMPLETED'].includes(req.status)) throw new Conflict('A payment has already started for this request.');
    const destValue = change.destination_value ?? req.destination_value, destType = change.destination_type ?? req.destination_type;
    run(db, `UPDATE payment_requests SET revision = revision + 1, status = 'RECEIVED', amount_minor = ?, currency = ?, destination_type = ?, destination_value = ?, destination_fingerprint = ?, vendor_id = ?, category = ?, updated_at = ? WHERE id = ?`,
      change.amount_minor ?? req.amount_minor, change.currency ?? req.currency, destType, destValue, destValue && destType ? destinationFingerprint(destType, destValue) : null, change.vendor_id ?? req.vendor_id, change.category ?? req.category, nowIso(), requestId);
    const inval = run(db, `UPDATE approvals SET invalidated_at = ? WHERE payment_request_id = ? AND invalidated_at IS NULL`, nowIso(), requestId);
    run(db, 'UPDATE policy_decisions SET superseded = 1 WHERE payment_request_id = ?', requestId);
    appendAudit(db, req.workspace_id, 'TRANSACTION_CHANGED', actor, requestId, { changed: Object.keys(change), approvals_invalidated: Number(inval.changes), new_revision: req.revision + 1 });
  });
  return evaluateAndRecord(ctx, requestId, actor);
}

export { paymentKey };
export const emptyField = unknown;
