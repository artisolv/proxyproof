# Connector API: MCP and REST

An externally created agent reaches ProxyProof in one of two ways:

- **MCP connector:** for agent platforms that support remote MCP. Identity is a ProxyProof connection token.
- **REST API:** for agents that can hold their own Ed25519 key. This gives the highest assurance.

`server/test/mcp.test.ts` exercises the connector with the official MCP TypeScript client. `server/test/external-agent.test.ts` is an agent written only against this page; it uses `jose` and HTTP and imports nothing from ProxyProof.

## MCP connector

| Property | Value |
|---|---|
| URL | `{PUBLIC_URL}/mcp` |
| Transport | Streamable HTTP, stateless, MCP spec **2026-07-28**. Clients using the 2025 protocol are served through the SDK's stateless fallback. |
| Auth | `Authorization: Bearer ppc_…`, the connection token shown once when the agent is connected in the dashboard. Only its SHA-256 is stored. |
| Origin check | Requests from browser origins other than localhost and the public host get 403 |

**Claude Code** (tested live against localhost):

```bash
claude mcp add --transport http proxyproof http://localhost:8787/mcp --header "Authorization: Bearer ppc_…"
```

### Tools

| Tool | Who | What it does |
|---|---|---|
| `proxyproof_get_agent_status` | any | Returns your organization, your state, and your exact authority |
| `proxyproof_list_counterparties` | any | Lists enrolled organizations and the catalog |
| `proxyproof_request_authority` | any | Asks your organization for a delegation. Grants nothing until a person approves it in ProxyProof |
| `proxyproof_submit_offer` | seller | Sends a signed quote or invoice, which is verified against the seller business's delegation |
| `proxyproof_review_transaction` | buyer | Shows the terms and whether the seller's agent was verified |
| `proxyproof_accept_transaction` | buyer | Signs acceptance of the current terms. Returns the decision, plus a permit on ALLOW |
| `proxyproof_execute_checkout` | buyer | Spends a permit to open a PayPal sandbox checkout. The buyer still approves the payment on PayPal |
| `proxyproof_get_decision_receipt` | any | Returns the decision, reasons and signed receipt |

**What the connector does not do:**
- No tool takes payment credentials.
- No tool completes a payment.
- Tool inputs are structured, so text from documents or web pages cannot widen an agent's authority.

## REST API

Base path: `/api/v1/workspaces/{ws}`.

### 1. Register

```
GET  /directory  → { audience, organizations: [{ name, role, did, status, payment_account }] }
POST /agents     { name, side: BUYER|SELLER, organization_did, public_jwk, provider? }
                 → 201 { agent_id, did, state: "CONNECTED", authorized: false }
```

- `public_jwk` must be a **public** Ed25519 JWK: `{"kty":"OKP","crv":"Ed25519","x":"…"}`. A JWK that contains `d` is rejected.
- The agent's identifier is the `did:key` of that key.

### 2. Wait for your organization, then collect your credential

```
POST /agents/credential { agent: <did> } → { authorized, state, credential, valid_until, mandate }
```

- The credential is a `vc+jwt` signed by the organization's key.
- Its `cnf.jwk` is your key, so it is useless without your private key.

### 3. Sign each act

**Get a challenge:**

```
POST /challenges { agent: <did> } → { nonce, expires_at, audience }
```

The nonce is single-use and expires after 5 minutes.

**Sign a JWS** with your private key:
- Header: `{"alg":"EdDSA","typ":"agent-request+jwt","kid":"<did>"}`
- Payload:

```json
{ "iss": "<did>", "aud": "<audience>", "iat": <now>, "jti": "<nonce>", "nonce": "<nonce>",
  "kind": "OFFER" | "ACCEPT", "counterparty": "<other organization's did>",
  "terms_hash": "<hex sha256 of canonical terms>", "delegation_hash": "<hex sha256 of your credential string>",
  "transaction_id": "<ACCEPT only>" }
```

**Canonical JSON** (used for the terms hash):
- Object keys are sorted.
- No whitespace.
- Strings are JSON-escaped.
- Integers only; floats are not allowed.
- `undefined` fields are omitted.

The terms format is described in [bilateral-commerce-model.md](bilateral-commerce-model.md).

### 4. Submit

```
POST /offers                     { request, delegation, terms, transaction_id? }   (seller agent; transaction_id revises existing terms)
GET  /transactions/{id}          → { terms, terms_hash, decision, reasons, checks, payment_state, decision_receipt, payment }
POST /transactions/{id}/accept   { request, delegation }                            (buyer agent) → … + permit on ALLOW
POST /transactions/{id}/execute  { permit }                                         → opens the PayPal checkout
GET  /transactions/{id}/proof    → { bundle, bundle_sha256, signature }
```

### 5. Verify independently

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/jwks.json` | Ed25519 key that signs receipts (`proxyproof-receipt+jwt`), permits (`execution-permit+jwt`) and evidence bundles |
| `POST /api/v1/receipts/verify { receipt }` | Convenience check of a receipt |
| `POST /api/v1/proofs/verify { bundle, signature }` | Checks a bundle |
| `GET /api/v1/status/{delegation_id}` | Returns `ACTIVE`, `REVOKED` or `SUPERSEDED`. Returns 503 when the status service is unavailable; treat that as unknown |

## Reason codes

Reason codes are listed per check in [threat-model.md](threat-model.md). Each check is in one of four states:

| State | Meaning |
|---|---|
| `pass` | The check succeeded |
| `hold` | Evidence is pending or unavailable |
| `review` | A person must approve these exact terms |
| `fail` | The check failed. Later checks on that side are reported as `not_reached` |
