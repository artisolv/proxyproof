# Standards status

Researched 2026-11-08 from primary sources (official repositories, specification sites and the IETF datatracker). Items marked UNVERIFIED could not be confirmed against a primary source.

## Model Context Protocol

The latest specification is **2026-07-28**. It includes breaking changes compared with 2025-11-25.

**Stateless protocol**
- No `initialize` handshake. Each request carries the protocol version, client capabilities and client info in `_meta`.
- Servers implement `server/discover`.
- `Mcp-Session-Id` and the GET server-sent-events (SSE) stream are removed.
- Long-running tasks use multi-round-trip `input_required` results.

**Streamable HTTP**
- One POST endpoint.
- The response is either `application/json` or SSE.
- The server must validate `Origin`.
- Every request carries the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers.

**Authorization is optional.** When it is implemented:
- OAuth 2.1 with Protected Resource Metadata (RFC 9728).
- PKCE with S256.
- Resource indicators (RFC 8707) and audience validation.
- Client ID Metadata Documents preferred. Dynamic Client Registration is deprecated.

**TypeScript SDK:** v2 (2.4.0, released 2026-10-23), split into `@modelcontextprotocol/server`, `client` and `hono`.

**Sources:** [MCP specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## Google AP2 (v0.2, released 2026-04-28)

**Format.** Mandates are **SD-JWT VCs** identified by `vct`, chained with Delegate SD-JWT (an individual draft). They are not W3C VC-JWTs.

| Mandate | `vct` | Contents |
|---|---|---|
| Open checkout | `mandate.checkout.open.1` | `cnf.jwk` for the agent key, plus `constraints` |
| Open payment | `mandate.payment.open.1` | `cnf.jwk` for the agent key, plus `constraints` |
| Closed checkout | `mandate.checkout.1` | `checkout_jwt`, `checkout_hash` |
| Closed payment | `mandate.payment.1` | `transaction_id`, `payee`, `payment_amount`, `payment_instrument` |

**Signing and binding**
- A closed mandate is bound to the transaction by a Key-Binding JWT (`kb+sd-jwt`) signed with the `cnf` key. It carries `aud`, `nonce`, `iat` and `sd_hash`.
- The merchant-signed `checkout_jwt` must use a non-deterministic signature such as ES256, **not** Ed25519.

**Payment constraints**
- `payment.allowed_payees`
- `payment.amount_range`
- `payment.budget`
- `payment.reference`
- `payment.agent_recurrence`
- `payment.allowed_payment_instruments`
- `payment.allowed_pisps`
- `payment.execution_date`

Unknown constraints must fail.

**Receipts.** A verifier-signed JWT with `iss`, `result` (or `status`), `reference` (the mandate hash) and AP2 error codes.

**Scope and implementations**
- Agent-to-agent delegation is **outside the specification's scope**.
- The official SDK is **Python only**. There is no official TypeScript implementation.

**Source:** [AP2 repository](https://github.com/google-agentic-commerce/AP2): `docs/ap2/*.md`, `code/sdk/schemas`.

## Other agent and commerce protocols

**A2A v1.0.1 (2026-05-28).**
- Agent Card at `/.well-known/agent-card.json`, with OpenAPI-style security schemes.
- Cards may be JWS-signed over JCS (RFC 8785).
- No principal-to-agent delegation format.

**ACP** (OpenAI and Stripe, beta, versions 2025-09-29 to 2026-04-17).
- Checkout, cart and orders.
- Delegated payment issues a vault token limited by an Allowance: `max_amount`, `currency`, `checkout_session_id`, `merchant_id` and `expires_at`.
- No principal-signed agent credential.

**UCP** (Google-led, v2026-08-25).
- Business capability profiles over REST, MCP or A2A.
- An AP2 Mandates extension: the business signs checkout responses and mandates are supplied at `complete`.

## OAuth building blocks

- **RFC 8693 Token Exchange.** Uses `act` and `may_act` claims; nested `act` represents a delegation chain.
- **RFC 9396 Rich Authorization Requests.** Typed `authorization_details` objects (actions, amounts, creditor).
- **RFC 9449 DPoP.** Per-request proof of possession bound to the HTTP method and URI, with `cnf.jkt` binding.
- **RFC 9421 HTTP Message Signatures.** The basis of Web Bot Auth and, per secondary sources (UNVERIFIED), Visa Trusted Agent Protocol.

## Card networks

**Visa Trusted Agent Protocol.**
- Agents sign each request to merchants.
- Merchants receive consented identifiers.
- Reference implementation in Python and Node.

**Mastercard Verifiable Intent** (Draft v0.1, 2026-03-05).
- A layered SD-JWT chain: issuer, then user intent, then agent action. The agent-action layer is split into L3a payment and L3b checkout.
- `transaction_id` must equal `checkout_hash`.

## IETF and other identity work (checked 2026-11-08)

**Working-group documents**

| Draft | Status |
|---|---|
| draft-ietf-oauth-v2-1 (-17) | Working-group document |
| draft-ietf-oauth-client-id-metadata-document (-03) | Working-group document |
| draft-ietf-oauth-identity-chaining (-17) | In the RFC Editor queue |
| draft-ietf-oauth-transaction-tokens (-11) | Working-group consensus |
| draft-ietf-oauth-sd-jwt-vc (-26) | IESG evaluation (SD-JWT itself is RFC 9901) |
| draft-ietf-wimse-aims (-01), "AI Identity Management System" | Working-group adopted |

**Individual drafts.** These cover agent authorization from many angles, including:
- draft-hardt-oauth-aauth-protocol
- draft-oauth-ai-agents-on-behalf-of-user
- draft-goswami-agentic-jwt
- draft-mcguinness-oauth-ai-agent-instance
- draft-liu-agent-operation-authorization
- draft-song-oauth-ai-agent-collaborate-authz
- draft-nandakumar-agent-sd-jwt

**Other bodies**
- **OpenID Foundation:** the AI Identity Management Community Group publishes whitepapers only.
- **W3C:** an Agent Identity Registry Protocol Community Group exists.

## What ProxyProof must not claim

- Compliance with or certification against AP2, Verifiable Intent, ACP, UCP, Visa TAP, W3C VC or MCP authorization.
- To be a standard, or to be endorsed by any of these organisations.
- That a did:key or signature proves real-world identity or KYC.
- That it can stop a compromised agent from misusing a valid permit within its scope. It limits the damage, not the misuse.
