# Bilateral commerce model

**One commercial transaction. Two independently verifiable authority chains. One matching transaction record. One enforceable decision.**

## The two questions

| Viewpoint | Question | What ProxyProof checks |
|---|---|---|
| Seller ("MAKE") | Is this buyer's AI agent authorized to make this purchase? | That the buyer organization's mandate covers this agent key, the `purchase` action, the amount, categories, seller and currency, and that it is still valid. Also that the agent signed these exact terms. |
| Buyer ("COLLECT") | Is this seller's AI agent authorized to represent the business and request payment? | That the seller business's delegation covers this agent key, `quote` or `issue_invoice` + `request_payment`, the buyer, the amount and the enrolled payment account, and that it is still valid. Also that the agent signed these exact terms. |

ProxyProof verifies both relationships **independently**, then requires both agents to have signed the **same terms hash**.

## Parties and objects

### Organizations

`principals` table, `role = BUYER | SELLER`.
- Each organization has its own Ed25519 key, a `did:key`, a key status, and an enrollment status and method.
- In the demo, enrollment is "demo enrollment": it was created by the hackathon's controlled onboarding, with no legal or KYB check.

### Agents

`agents` table.
- Each agent has a public key, a DID and a provider label ("Claude Code", "Custom framework", "ProxyProof test agent").
- **Connection:**
  - `API`: the agent holds its own key.
  - `MCP`: ProxyProof issues a connection token and holds a signing key for the connection.
  - `TEST_RUNTIME`: a labelled test agent.
- Each agent records the assurance level its connection actually provides.

### Delegations

`delegations` table.
- A delegation is requested, then approved by a person acting for the organization.
- It is then signed by the organization's key as a `vc+jwt`. The credential is shaped like a W3C VC 2.0 credential and binds the agent key through `cnf.jwk` (RFC 7800).
- Its **mandate** contains:
  - `actions`
  - `max_amount_minor`, `currencies`, `categories`
  - `counterparties`: the DIDs of allowed counterparties
  - `destinations`: sellers only, the allowed payment accounts
  - `step_up_above_minor`: buyers only, the review threshold
  - `may_delegate`
- It also carries an expiry and a status, with revocation that cascades to children.

### Commercial terms

The terms are the canonical object both agents sign:

```json
{ "reference": "INV-1001", "document": "QUOTE | INVOICE", "seller": "<did>", "buyer": "<did>",
  "items": [{ "name": "...", "category": "...", "quantity": 1, "unit_amount_minor": 6800 }],
  "currency": "USD", "total_minor": 6800, "payment_destination": "<PayPal account>", "expires_at": "<ISO 8601>" }
```

- Money is in integer minor units.
- `terms_hash` is the SHA-256 of the canonical JSON: sorted keys, no whitespace, integers only, unknown fields rejected. This follows the JCS (RFC 8785) rules for the value types ProxyProof allows.

### The transaction envelope

`commerce_transactions` table. It is an internal record, not a protocol. It holds:
- the version and history
- the terms and terms hash
- both organizations and both agents
- the evidence each side presented (signed request, delegation credential, each check result)
- the match results
- the decision, reasons and signed decision receipt
- review approval
- permits (`execution_permits`)
- the **payment state**, which is kept separate from the decision

## Flow

1. **Seller agent: OFFER.**
   - It gets a challenge and signs `{kind: OFFER, nonce, counterparty, terms_hash, delegation_hash}`.
   - It submits the request, its delegation and the terms.
   - ProxyProof verifies the seller side. The decision is HOLD (`BUYER_AUTHORIZATION_PENDING`), or DENY if the seller side fails.
2. **Buyer agent: ACCEPT.**
   - It reads the terms and signs `{kind: ACCEPT, nonce, counterparty, terms_hash, delegation_hash, transaction_id}`.
   - ProxyProof verifies the buyer side and re-verifies the seller side on live state.
3. **Match.** The match fails if either of these is true:
   - the seller's signed hash differs from the terms (`TERMS_MODIFIED`)
   - the buyer's signed hash differs from them (`TERMS_MISMATCH`)

   It also checks the transaction ID and that the terms have not expired.
4. **Policy:**
   - **DENY** if any check fails.
   - **HOLD** if evidence is pending or unavailable.
   - **REVIEW** if the amount is above the buyer's review threshold and the buyer organization has not approved these exact terms.
   - **ALLOW** otherwise.
5. **ALLOW.** ProxyProof issues a single-use, 5-minute **execution permit** bound to `{transaction, terms_hash, action: create_checkout, decision receipt hash}`.
6. **Executor.**
   - It verifies the permit, claims it atomically, re-verifies both sides on live state, then calls PayPal Orders v2.
   - The buyer approves on PayPal. A capture re-verifies authority again.
   - The state becomes `COMPLETED` only when PayPal confirms it.
7. **Evidence.** A signed bundle links both chains, the match, the decision, permits and the outcome.

## Matching rules

ProxyProof never coerces differences:
- **Revised terms:** a revision by the seller's agent creates version *n+1*. It clears the buyer's acceptance and voids unused permits; the executor refuses permits that carry an old hash.
- **Different terms:** a buyer agent that signs different terms is refused (`TERMS_MISMATCH`). Different amount, items, destination or parties all produce a different hash.

## Separation of concerns

These are kept in separate fields and tables, never inferred from one another:
- **Connection:** token or key.
- **Agent identity:** the registered key.
- **Organization identity:** enrollment.
- **Delegated authority:** the signed credential and its status.
- **Transaction authorization:** the decision, the review approval and the permit.
- **Payment authorization:** the buyer's approval on PayPal.
- **Settlement outcome:** provider confirmation.
