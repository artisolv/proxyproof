import { canonicalize, sha256 } from './util.js';

/** Transaction Trust Envelope: the canonical form of a payment, and the thing approvals are bound to. */
export type TTE = {
  transaction_id: string; workspace_id: string; revision: number;
  principal_id: string | null; agent_id: string | null; authorization_id: string | null; authorization_version: number | null;
  payee_id: string | null; payee_destination_fingerprint: string | null;
  invoice_id: string | null; invoice_fingerprint: string | null;
  amount_minor_units: number | null; currency: string | null; category: string | null;
  source_artifact_ids: string[]; policy_version: number; rail: string;
};
export function transactionFingerprint(t: TTE): string {
  return sha256(canonicalize({ ...t, source_artifact_ids: [...t.source_artifact_ids].sort() }));
}
/** Business key independent of the request, so the same invoice cannot be paid through two requests. */
export function paymentKey(p: { workspaceId: string; vendorId: string; invoiceFingerprint: string | null; requestId: string; amountMinor: number; currency: string }): string {
  return sha256(canonicalize({ w: p.workspaceId, v: p.vendorId, i: p.invoiceFingerprint ?? `no-invoice:${p.requestId}`, a: p.amountMinor, c: p.currency }));
}
