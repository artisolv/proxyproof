# Threat model

Each threat is mapped to its control and to the automated test that exercises it. **Tested** threats are covered by `npm test`, with results in `docs/testing/`.

| Threat | Control | Result / code | Test |
|---|---|---|---|
| Forged buyer mandate | Signature must verify against the buyer organization's key | DENY `DELEGATION_FORGED` | bilateral 8 |
| Forged seller delegation | Same, against the seller business's key | DENY `DELEGATION_FORGED` | bilateral 8 |
| Untrusted issuer | Issuer must be the agent's own organization | DENY `WRONG_ISSUER` | bilateral 8 |
| Agent authorizes itself | Self-signed credentials are rejected | DENY `SELF_DELEGATION` | bilateral 8 |
| Stolen credential presented by another key | `cnf.jwk` binding and proof of possession | DENY `KEY_NOT_BOUND` / `SIGNATURE_INVALID` | bilateral 8 |
| Unknown agent impersonating a business | Only registered keys are known | DENY `AGENT_UNKNOWN` | bilateral 8, dashboard 8b |
| Agent substitution (wrong side) | Agent side must match its role | DENY `AGENT_WRONG_SIDE` | unit path in `party.ts` |
| Principal substitution | Terms must name the agent's own organization | DENY `PARTY_MISMATCH` | `party.ts` |
| Out-of-scope action (research agent buys, quote-only agent invoices) | Action checked against the signed mandate | DENY `ACTION_NOT_PERMITTED` | bilateral 2, 4 |
| Over limit | Amount limit | DENY `AMOUNT_EXCEEDS_LIMIT` (or REVIEW between threshold and limit) | bilateral 3 |
| Unapproved counterparty | Counterparty list | DENY `COUNTERPARTY_NOT_APPROVED` | `party.ts` |
| Wrong payment destination | Allowed destinations, plus the account the business enrolled | DENY `DESTINATION_NOT_AUTHORIZED` / `DESTINATION_NOT_LINKED` | bilateral 6 |
| Expired or revoked credentials | Expiry claims and status lookup on every check | DENY `DELEGATION_EXPIRED` / `DELEGATION_REVOKED` | bilateral 7 |
| Revocation between decision and payment (time of check vs time of use) | Executor re-verifies on live state | `LIVE_RECHECK_FAILED` | execution: time of use |
| Terms changed in transit | Signed hash compared with the presented terms | DENY `TERMS_MODIFIED` | bilateral 8 |
| Terms changed after approval | New version voids the acceptance and permits; the executor compares hashes | HOLD, then `TERMS_CHANGED` | bilateral 5 |
| Buyer and seller disagree on terms | Both must sign the same hash | DENY `TERMS_MISMATCH` | bilateral 5b |
| Replay or nonce reuse | Single-use challenges, claimed atomically | DENY `REPLAY` | bilateral 9 |
| Stale request | Five-minute freshness window | DENY `REQUEST_STALE` | bilateral 8 |
| Concurrent double execution | Atomic permit claim, unique live attempt, idempotency key | One checkout only | execution: concurrent, single use |
| Direct executor bypass | Permit required and verified | `PERMIT_MISSING` / `PERMIT_INVALID` / `PERMIT_WRONG_TRANSACTION` | execution 12 |
| Webhook forgery | PayPal signature verification; unverified events are ignored | No state change | execution: webhooks |
| Dependency outage or stale revocation information | Status lookup fails closed | HOLD `STATUS_UNAVAILABLE` | bilateral 11 |
| Unauthenticated MCP access | Bearer token checked against a stored hash; Origin validated | 401 / 403 | mcp |
| Cross-tenant access | Every lookup scoped by workspace | 404 | covered by route design; no dedicated test |
| Prompt injection into agent inputs | Tools accept only structured inputs; authority comes only from signed delegations, so injected text cannot grant permission | Refusal by policy | design (MCP tool schemas) |
| Alternate tool or payment path | **Not controlled.** ProxyProof enforces only protected actions routed through it | — | Out of scope (documented) |
| Stolen organization signing key | Organization `key_status` can be revoked; production needs a KMS or HSM and rotation | Partial | Future |
| Invalid sub-delegation and privilege escalation | Schema supports parent links and revocation cascades to children | Partial: no chain verification yet | Future |
