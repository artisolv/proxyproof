# Adversarial test results

Generated 2026-11-08T12:26:50.520Z by `npm run test:report` (every number comes from that run).

**Environment:** Node v24.21.0, darwin arm64, Apple M4, in-memory SQLite, PayPal mocked on loopback.

**Result:** 30 of 30 tests passed, 0 failed.

A small suite proves only the properties it tests. It is not evidence of production-scale reliability. No reliability score is claimed.

## Properties

| Property | Tests | Failed |
|---|---|---|
| Valid bilateral transaction allowed | 4 | 0 |
| Seller authority failures rejected | 5 | 0 |
| Buyer scope and authority failures rejected | 4 | 0 |
| Invalid signatures, forged or self-issued authority | 3 | 0 |
| Transaction mutation and term changes | 3 | 0 |
| Replay and duplicate execution | 3 | 0 |
| Revocation and expiry enforced, including at time of use | 4 | 0 |
| Fail closed when a dependency is unavailable | 1 | 0 |
| Direct executor bypass attempts | 2 | 0 |
| Payment completion only on provider confirmation | 2 | 0 |
| Evidence bundle integrity | 1 | 0 |
| MCP connector authentication and scope | 5 | 0 |
| Architecture boundaries | 2 | 0 |

Some tests count towards more than one property.

## Verification latency

seller offer + buyer acceptance via the public API, including signing, both-side verification and matching: **p50 2.9 ms, p95 4.6 ms**, over 40 in-process runs.

This measures ProxyProof's own work only. It excludes network and PayPal time.

## All tests

| Test | Status | ms |
|---|---|---|
| bilateral verification › 1. both sides valid: ALLOW with both authority chains and the match recorded, and a single-use permit | passed | 57 |
| bilateral verification › 2. seller agent not authorized to invoice: DENY, never presented as a verified seller request | passed | 26 |
| bilateral verification › 3. buyer over its limit: DENY; between the approval threshold and the limit: REVIEW, then ALLOW after approval | passed | 28 |
| bilateral verification › 4. same owner, different agent: the research agent fails on authority, the procurement agent passes | passed | 26 |
| bilateral verification › 5. terms changed after approval: the earlier authorization and permit no longer apply | passed | 26 |
| bilateral verification › 5b. a buyer agent that authorizes different terms from those on the table is refused | passed | 14 |
| bilateral verification › 6. wrong payment destination: DENY before any payment | passed | 10 |
| bilateral verification › 7. expired and revoked authority, on both sides | passed | 32 |
| bilateral verification › 8. invalid seller signature, forged or self-issued authority, unknown keys and missing proof are rejected | passed | 49 |
| bilateral verification › 9. replayed requests are refused on both sides | passed | 17 |
| bilateral verification › unverified organizations are held, not trusted and not denied | passed | 9 |
| bilateral verification › 11. verification dependency unavailable: HOLD, then recovery after it returns | passed | 15 |
| bilateral verification › expired terms cannot be accepted | passed | 11 |
| bilateral verification › the path stops at the first failed check on each side | passed | 10 |
| protected execution boundary › a valid permit opens a PayPal checkout; COMPLETED only after PayPal confirms the capture | passed | 67 |
| protected execution boundary › 12. bypass: no permit, a forged permit, or a permit for another transaction is refused, and PayPal is never called | passed | 41 |
| protected execution boundary › 9. a permit is single use: a second execution is refused and recorded | passed | 23 |
| protected execution boundary › concurrent executions with two valid permits create one checkout | passed | 19 |
| protected execution boundary › time of use: revoking the seller agent after approval stops execution at the boundary | passed | 19 |
| protected execution boundary › revoking after checkout opened prevents capture | passed | 22 |
| protected execution boundary › unverified webhooks change nothing | passed | 18 |
| protected execution boundary › the evidence bundle links both chains, verifies, and detects tampering | passed | 21 |
| architecture › only the executor and app wiring can reach the PayPal client | passed | 1 |
| architecture › the MCP connector cannot reach the PayPal client or private key tables directly | passed | 0 |
| an independently developed agent on the REST API › registers with its own key, waits for its organization, accepts a verified invoice and checks the receipt | passed | 59 |
| an independently developed agent on the REST API › rejects a registration carrying a private key | passed | 8 |
| ProxyProof MCP connector › refuses a connection without a valid ProxyProof connection token | passed | 34 |
| ProxyProof MCP connector › refuses requests from a foreign browser origin | passed | 8 |
| ProxyProof MCP connector › connected is not authorized; the organization approves; then two MCP agents complete one bilateral transaction | passed | 95 |
| ProxyProof MCP connector › a seller agent cannot use buyer tools and vice versa | passed | 9 |

## Live checks against the PayPal sandbox (2026-11-08)

These checks used the real UI with this server's sandbox credentials. They were performed once and are not part of the automated suite:

- **Scenario 1 (both sides valid):** the full bilateral flow reached ALLOW, the permit was admitted, and sandbox order `7DT525101K945040G` was created, awaiting buyer approval.
- **Scenarios 2, 3b, 4, 5, 6, 8b, 11 and 12:** the dashboard showed the expected outcome, and the server's own reason codes matched the automated tests above.
- **Completing the payment:** this needs a person to approve the order as the sandbox buyer on PayPal. It has not been done yet in this environment.
