# Architecture decisions

The decisions below were made on 2026-11-08 against `new_plan.md` (ProxyProof v2.0).

## Answers to the plan's open questions (section 15)

**1. Which AP2 mandate type is usable?**
AP2 v0.2 mandates are SD-JWT VCs (`mandate.payment.open.1` and others) with KB-JWT binding. The only official SDK is in Python.
- An SD-JWT and Delegate SD-JWT verifier in TypeScript could not be built and conformance-tested in the time available.
- So the buyer mandate is a **ProxyProof demo profile** that follows AP2's ideas: a `cnf`-bound agent key, constraints, and an exact checkout hash.
- An AP2 adapter is **future work**. No AP2 compliance is claimed.

**2. What seller-side delegation evidence can be built without misrepresenting a standard?**
A `vc+jwt` signed by the seller business's key, shaped like a W3C VC 2.0 credential and binding the agent key through `cnf.jwk` (RFC 7800).
- It is labelled **experimental: a ProxyProof profile**.
- It is not validated against the VC conformance suites.

**3. How are the buyer and seller organizations enrolled and trusted for the demo?**
Through demo enrollment created by the hackathon's controlled onboarding, and disclosed as such: no legal or KYB check. Each organization has its own Ed25519 key. One unverified organization on each side exercises the HOLD path.

**4. What identifies an agent instance, as opposed to an MCP client or an OAuth session?**
No platform exposes a cryptographic agent-instance identity to MCP servers (see `research/protocol-compatibility.md`). ProxyProof binds identity itself and records the assurance level:
- **REST agents:** the agent's own key. This is the highest assurance.
- **MCP:** a ProxyProof-issued connection token (stored as a hash) plus a ProxyProof-held key for that connection.
- **Test agents:** labelled as such.

**5. What is the maximum revocation-staleness window?**
**Zero.** Delegation status is read on every check: at offer, at acceptance, at the executor, and at capture. If the status service is unavailable, the result is HOLD (`STATUS_UNAVAILABLE`), never a cached ALLOW.

**6. Which payment operation is available?**
PayPal **Orders v2** create and capture, in the sandbox. It was verified live: order `7DT525101K945040G` was created through the protected flow.
- Invoicing v2 also works with these credentials, but was dropped for the bilateral flow. Checkout keeps the buyer's own approval on PayPal.
- Payouts are not used.

**7. Can both parties be verified before payment while preserving buyer checkout consent?**
Yes. ProxyProof verifies both chains and the match, issues a permit, and the executor creates the order. The **buyer approves on PayPal**, which no agent can do. Capture re-verifies authority first.

**8. Which external agent platform can be connected and tested before the deadline?**
- **Claude Code**, through the MCP connector on localhost. The `claude mcp add` command is supported by its docs.
- **Independently written REST agents**, tested in `external-agent.test.ts`.
- The connector is also tested with the official MCP TypeScript client, in both protocol modes.
- Claude.ai, ChatGPT, Grok and Gemini need a public HTTPS URL. They are documented, not shown as live. A live Claude Code run was attempted on 2026-11-09 but blocked because the standalone CLI's sign-in had expired; the user chose to skip it. The connector is verified by `mcp.test.ts` with the official MCP client.

**9. What is ProxyProof's own logic, and what is adapter logic?**

| Kind | Where it lives |
|---|---|
| ProxyProof logic | `trust/party.ts` (one-side verification), `trust/bilateral.ts` (match, policy, permits, evidence), `executor/gate.ts` |
| Adapter logic | `executor/paypal.ts` (the PayPal rail) and `mcp/server.ts` (the MCP connector) |

**10. Which guarantees cannot be made?**
- ProxyProof cannot control an agent's other tools, payment credentials or browser sessions.
- It cannot stop misuse within a valid delegation.
- A bearer connection token can be stolen.
- See `architecture/security-model.md`.

## Other decisions

| Decision | Reason |
|---|---|
| Logo: a double check mark (deep green, then bright green) in a white circle, with the wordmark set in Schibsted Grotesk | One tick per side of the payment, matching the two greens the landing page uses as each agent is verified. Replaced the earlier two-P monogram, which sat too close to "PP" payment marks. No PayPal assets are used. |
| Rebuilt rather than renamed. The old one-sided verifier, runtime and pages were removed; the earlier versions remain in git (commits `213c93b` and before) | The plan requires a coherent product, not retained features |
| MCP SDK v2 (`@modelcontextprotocol/server` 2.4.0), stateless Streamable HTTP, spec 2026-07-28 with legacy fallback | This is the current spec. Gemini requires Streamable HTTP. |
| Bearer connection tokens for MCP; OAuth 2.1 with Protected Resource Metadata deferred | Works with Claude Code today. Labelled honestly as "connection token" assurance. |
| USD for all amounts | The PayPal sandbox account runs in USD. INR scenarios from the brief were mapped to USD amounts. |
| Removed the optional Claude cart-drafting module and the Anthropic SDK | ProxyProof does not provide agent intelligence. External agents bring their own. |
| Delegations carry `parent_id`, and revocation cascades to children | This prepares sub-delegation (plan P1). Chain verification with attenuation is **not implemented yet**. |
| Decision and payment state stored in separate columns | The plan requires that authorization and payment lifecycle never mix |
