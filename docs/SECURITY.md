# Security model and test results

PayeeProof does not claim to detect every fraud. It aims to make every payment pass one enforcement boundary, to fail closed when something critical cannot be verified, and to show the evidence for each decision.

## Invariants and how they are enforced

| Invariant | Enforcement | Test |
| --- | --- | --- |
| No model, browser or connector can call the executor | The PayPal rail requires a gate pass that only `gate.ts` can mint; an import rule is checked by a test | `executor.test.ts` architecture tests; forged pass rejected |
| No payment without a valid deterministic decision | The gate verifies the HMAC-signed decision is current, unexpired and ALLOW, then re-runs the engine on live state | Bypass suite H09; held and denied tests |
| No approval reused after a material change | Approvals bind to the transaction fingerprint and policy version; amendments void them | T13; fingerprint mismatch returns 409 |
| No double payment | Partial unique index on `(workspace, payment_key)`, unique decision per attempt, `ALREADY_PAID` rule, PayPal idempotency keys | Concurrent release test; T14; replay in UI |
| No unverified destination becomes trusted | Destinations are added only by an owner or finance admin, with a recorded verification method | `DESTINATION_UNVERIFIED` and policy tests |
| No AI output accepted as proof | Model schemas have no verdict field. Model-only reads cause REVIEW, and disagreements cause HOLD. | H02 and the lying-model test |
| No critical unknown read as safe | UNKNOWN or CONFLICT on amount, currency, invoice number or vendor causes HOLD; unreadable files cause HOLD | H08 and parser tests |
| No secrets in model context or client code | Credentials are read only in `executor/paypal.ts`; prompts get document text and system facts only | Architecture test |
| All webhooks authenticated | PayPal `verify-webhook-signature`, cert host allowlist, raw body, deduplication by event ID; no webhook ID means reject all | Webhook tests, T17 |
| Verification failures hold, not allow | Registry failure triggers `VERIFICATION_UNAVAILABLE` | T16 |
| Tamper-evident audit | SHA-256 hash chain plus triggers that block UPDATE and DELETE | Ledger tamper test |

## Threats from the plan and their coverage
Prompt injection in an invoice (T10, H01) and on a vendor website (website test). Lookalike domains (T03). Reply-to mismatch (H07). Destination substitution (T02, T19). Amount inflation (H06, T20). Duplicates (T04, T05). A valid vendor name with a new destination (T02). Forged or expired authorization (H04, T08). Over budget (T06, plus a policy test). An unapproved vendor (T07). A payee changed after approval (T13). Revocation during a pending request: revocation is re-read at every evaluation and again at the gate (T09). Replay (H05, T14). Duplicate webhook delivery and forged webhooks (webhook tests, T17). A false "verified" from the LLM (H02). Evidence provider unavailable (T16). Conflicting OCR or extraction (parser conflict tests). Malicious or oversized files (H08, a 10 MB limit, a 20-page limit, timeouts, and content sniffing).

## Other controls
Session cookies are HttpOnly and SameSite=Lax, with a custom-header requirement on every state-changing API call (CSRF). Roles are enforced server-side, a strict CSP is set, and requests are rate-limited per address. Passwords are hashed with scrypt. The workspace is checked on every query, and challenge workspaces are readable by their parent but never writable. Public lookups allow HTTPS to public addresses only, with no redirects and a size cap. The PayPal base URL must be the sandbox or a loopback mock.

## Independent review (2026-11-08)
A separate review agent attacked the gate, pipeline and routes. It confirmed three issues, all now fixed and covered by `review-regressions.test.ts`:
1. **High:** an unreadable file, or a manual request with no invoice, skipped duplicate detection, so the same amount could be paid repeatedly. It is now held: an unreadable file is a critical unknown, identical file hashes count as duplicates, and the same vendor and amount within 30 days without an invoice fires `POSSIBLE_REPEAT_PAYMENT`.
2. **Medium:** unauthenticated agent posts were ingested and could plant invoices that blocked real ones, or shift the vendor's history baseline. Unverifiable agent requests are now recorded and denied without ingesting files, denied requests don't count as duplicates, and history uses paid invoices only.
3. **Medium:** anyone could open a demo workspace and drain the shared sandbox balance, and forwarded IP headers were trusted. Sandbox payments are now capped per workspace and per day, live scenarios need a finance role, and `X-Forwarded-For` is trusted only with `TRUST_PROXY=1`.

Lower-severity items were also fixed: the payment rail is now part of the transaction fingerprint, approvals cover only the reason codes the approver saw, the agent signature binds every attached file, a completed payment can only move to refunded, and capture checks the attempt state and actor.

## Results (2026-11-08)
- `npm test`: 57 of 57 tests pass offline, including checks that every dashboard number equals a count of stored records and that no held, denied or under-review sample can reach the executor.
- Security Testing scenario suite in the UI: 28 of 28 offline scenarios behaved as published, with 0 false positives and 0 false negatives.
- Live PayPal sandbox: a permitted invoice was paid and confirmed COMPLETED by authenticated API lookup, both by script and through the UI. A held request was refused at the gate, and all 8 bypass attempts were refused with no provider call. An Orders checkout was created with a sandbox approval link.

## Known limits
- Uploaded email headers can be forged. They count against a sender but never in its favour.
- The deterministic parser expects labelled invoices. Unusual layouts produce UNKNOWN fields, which hold the payment; Claude helps when configured.
- Rate limits and sessions are in memory and SQLite on a single instance.
- Live webhook verification needs a public URL and a registered webhook ID; locally it is tested against a mock of PayPal's verification API.
