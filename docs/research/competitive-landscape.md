# Competitive landscape

Researched 2026-11-08 from public sources. Anything marked UNVERIFIED could not be confirmed against a primary source. Two URLs in the original brief returned 404, so the current official pages were used instead: [MCP server](https://developer.paypal.com/ai-tools/mcp-server.md) and [Agent Toolkit](https://developer.paypal.com/ai-tools/toolkit.md).

## Summary

Every individual piece of ProxyProof already exists in public work. Among the sources searched, **no public system was found** that combines all three of these:

1. **Two independent authority checks.** It verifies that the buyer organization authorized the buyer agent, *and* that the seller business authorized the seller agent to issue this quote or invoice.
2. **Shared signed terms.** Both delegated agents must sign the same canonical terms.
3. **A gated payment.** A short-lived, single-use permit bound to those terms is required before a PayPal Orders v2 (sandbox) call.

ProxyProof is a hackathon-grade reference implementation of that combination. It is not a new protocol or standard. This conclusion covers only the sources listed under each entry below, not private deployments.

## Entries

### PayPal MCP Gateway

**Source:** "What We Learned Building PayPal's MCP Gateway", PayPal developer blog, 2026-10-08. [Link](https://developer.paypal.com/community/blog/PayPal_MCP_Gateway/)

**What it is:** PayPal's internal entry point to about 200 MCP servers and 3,318 tools.

**What it does:**
- Authenticates the caller once and keeps that identity through discovery, authorization, execution and audit.
- Filters discovery by entitlements, and checks authorization again before each `execute_tool`.

**What it does not do:** delegated grants, transaction binding, cross-organization flows, or buyer and seller roles.

**How ProxyProof uses it:** as a reference only. The principle of re-checking authorization at execution time is PayPal's, not ours.

### PayPal MCP server and Agent Toolkit

**What they are:**
- `@paypal/mcp`, plus remote endpoints at `mcp.sandbox.paypal.com` and `mcp.paypal.com`.
- `@paypal/agent-toolkit`, which wraps orders, invoices, products, subscriptions, shipment and disputes.

**How they authenticate:** with the merchant's client credentials.

**What they do not do:** neither has an agent delegation model.

**How ProxyProof relates:** ProxyProof sits in front of PayPal Orders v2. It does not rebuild these tools.

### PayPal Agent Ready

**Source:** [Agent Ready overview](https://developer.paypal.com/agent-ready/overview/), updated 2026-10-13.

**What it is:** lets Braintree and PayPal merchants accept payments started by AI surfaces, through three routes:
- ACP via ChatGPT, using a delegated token.
- UCP with Braintree, using a single-use Google Wallet token.
- UCP with PayPal, using a Google Pay credential sent to Orders v2.

**How ProxyProof relates:** a plain sandbox Orders v2 integration is **not** Agent Ready. ProxyProof does not use delegated payment tokens.

### EMILIA Protocol

**Sources:** [repository](https://github.com/emiliaprotocol/emilia-protocol); [draft-schrock-ep-authorization-receipts-13](https://datatracker.ietf.org/doc/draft-schrock-ep-authorization-receipts/), an individual IETF draft.

**What it does:**
- Gates protected tools on finite mandates.
- Hashes the exact action as JCS-canonical JSON with SHA-256.
- Uses approver-signed contexts, consumed once and atomically, with replay refused.
- Issues offline-verifiable receipts.
- Includes a payment demo that refuses a payment if it was changed.

**How ProxyProof relates:** EMILIA is the **closest prior art to ProxyProof's execution permit**. ProxyProof's permit is its own minimal version and credits EMILIA. EMILIA uses "bilateral" for confirmation by both parties *after* an event, which is different.

### OpenA2A Agent Authorization Protocol (AAP)

**Sources:** [draft-fane-opena2a-aap-02](https://datatracker.ietf.org/doc/draft-fane-opena2a-aap/), an individual draft; [repository](https://github.com/opena2a-standards/agent-authorization-protocol).

**What it defines:**
- Agent identity tokens and short-lived capability grants.
- Delegation that can only narrow permissions, with proof of possession.
- Cascading revocation and federation across organizations.

**What it does not cover:** transaction binding or buyer and seller roles. Its own text says several parts have no implementation yet.

**How ProxyProof relates:** a reference model for scoped grants that can only narrow.

### OpenID AuthZEN Authorization API 1.0

**Source:** [AuthZEN Authorization API 1.0](https://openid.net/specs/authorization-api-1_0.html), **Final** since January 2026.

**What it defines:** `POST /access/v1/evaluation`, which takes `{subject, action, resource, context}` and returns `{decision}`.

**Related drafts:** COAZ and COAZ-MCP are working-group drafts, not final.

**How ProxyProof relates:** each side's check can be expressed as an evaluation call in AuthZEN's shape. ProxyProof claims conformance only if it is tested.

### draft-reece-wimse-cross-org-delegation

**Source:** [draft-reece-wimse-cross-org-delegation-02](https://datatracker.ietf.org/doc/draft-reece-wimse-cross-org-delegation/), an individual Informational draft.

**What it contains:** requirements only:
- Cross-organization chains that narrow at each step.
- Revocation that fails safe.
- Proof of possession.
- Composable audit.
- Human approval at execution time, bound to the exact action and usable once.

**How ProxyProof relates:** ProxyProof maps partially to these requirements, as an experiment.

### UCP AP2 Mandates extension (2026-08-25) and AP2 v0.2

**Sources:** [ucp.dev AP2 mandates extension](https://ucp.dev/specification/payment/extensions/ap2-mandates/); [AP2 repository](https://github.com/google-agentic-commerce/AP2).

**What it does:**
- The business signs the canonical checkout (detached ES256 JWS).
- The user or platform signs an SD-JWT checkout mandate that embeds the business's signature.

**What it does not do:** verify that a *seller-side agent* is authorized by the business. It trusts the business key directly.

**How ProxyProof relates:** a reference, and a possible future adapter.

### Delegation receipt drafts

**Sources:**
- [draft-nelson-agent-delegation-receipts-15](https://datatracker.ietf.org/doc/draft-nelson-agent-delegation-receipts/): user-signed receipts, sub-receipts that can only narrow, cascading revocation, and a gate that fails closed.
- [draft-le-agent-passport-00](https://datatracker.ietf.org/doc/draft-le-agent-passport/): agent passports, delegation receipts that can only narrow, RFC 9421 signatures, and status lists. Verification runs one way.

Both are individual drafts.

**How ProxyProof relates:** ProxyProof's delegations are delegation receipts in substance. Cite these drafts rather than presenting delegation receipts as new.

### Open Agent Commerce

**Source:** [openagentcommerce.org](https://openagentcommerce.org/), demonstrated in October 2026.

**What it does:**
- The buyer runs 14 checks on the seller, and the seller runs 10 checks on the buyer.
- Signed quotes, AP2 mandates scoped to a single seller, and an independent verifier.

**Gaps, by its own statement:**
- No seller-business-to-seller-agent mandate.
- No single object co-signed by both sides.

**How ProxyProof relates:** the **strongest bilateral prior art** found. Reference it.

### Agentic Settlement Protocol

**Source:** [arXiv:2609.02208](https://arxiv.org/html/2609.02208v1), a v0.6 draft.

**What it does:**
- A seller signs a standing mandate that lets an operator issue offers within limits.
- The buyer authorizes by the offer's hash.
- Payment uses stablecoin rails.

**How ProxyProof relates:** a reference for seller-side mandates.

### Visa Trusted Agent Protocol and Mastercard Agent Pay

**What they do:** merchants verify registered *buyer* agents. This works in one direction only.

**How ProxyProof relates:** reference only. ProxyProof does not use or simulate either.

## Capabilities and ProxyProof's role

| Existing capability | Provided by | ProxyProof's role |
|---|---|---|
| Orders create and capture | PayPal Orders v2 | **Integration** (sandbox) |
| Identity-attached tool authorization within one organization | PayPal MCP Gateway | Reference |
| Agent identity and narrowing delegation | AAP, Agent Passport, Delegation Receipts | **Implementation**: simplified, experimental |
| Decision API | AuthZEN 1.0 | Shaped like AuthZEN; future work to test conformance |
| Exact-action hash, single-use permit, replay refusal | EMILIA | **Implementation**: own minimal version, credits EMILIA |
| Business and user signatures over one checkout | UCP AP2 extension, AP2 | Reference; future adapter |
| Seller-side mandate for issuing offers | Agentic Settlement Protocol | **Implementation**: seller-agent delegation, experimental |
| Two-sided checks between organizations | Open Agent Commerce | Reference |
| Delegated payment tokens | PayPal Agent Ready (ACP, UCP) | Not used; future work |

## Claims ProxyProof must not make

- **Novelty:** not "first" or "novel" in agent authorization, delegation receipts, transaction binding, execution gates or bilateral verification. At most: "We found no public system combining all three properties among the sources searched."
- **Compliance or endorsement:** not Agent Ready, ACP or UCP compliant, and not endorsed or certified by PayPal, Google, OpenID or the IETF.
- **Conformance:** not conformant to AuthZEN, COAZ, AAP, AP2 or any IETF draft unless tested. No cited draft should be presented as a standard.
- **Identity:** ProxyProof does not verify an organization's real-world legitimacy, run KYB checks, or establish that a payee's bank details are legitimate.
- **Production guarantees:** none, including exactly-once execution across domains or real revocation propagation.
- **Bypass:** ProxyProof protects only calls that go through it.
- **Federation:** both organizations in the demo are simulated, so this is not cross-organization federation at scale.
