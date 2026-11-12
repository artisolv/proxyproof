# ProxyProof

**Verify both sides before AI agents transact.**

**Live demo:** https://proxyproof.artisolv.com · open **Explore Live Demo** for the scenario lab.

> Is this AI agent authorized to **MAKE** / **COLLECT** payment?

ProxyProof verifies both sides of agentic commerce:
- **The buyer's agent:** is it authorized by the buyer organization to commit to this purchase?
- **The seller's agent:** is it authorized by the business to represent it and request payment?

It checks each side's evidence independently and confirms both agents signed the same commercial terms. Only then does a protected PayPal sandbox checkout start.

**One commercial transaction. Two independently verifiable authority chains. One matching transaction record. One enforceable decision.**

> Independent hackathon project for the PayPal AI Hackathon. Not affiliated with or endorsed by PayPal, Anthropic, OpenAI, xAI, Google, Visa or Mastercard. Payments use the PayPal sandbox and move no real money.

## What it is, and what it is not

ProxyProof is an implementation and interoperability layer. It is **not**:
- an agent builder
- a PayPal connector
- a payment network
- a new cryptographic standard

It does not replace AP2, ACP, UCP, Visa TAP, Verifiable Intent, AuthZEN or PayPal's agent tools; [docs/research](docs/research) credits each of them. It enforces only protected actions routed through it.

## How it works

1. **Organizations delegate.**
   - Each buyer or seller organization has its own signing key.
   - Agents created anywhere (Claude, ChatGPT, Grok, Gemini or any framework) connect through the **MCP connector** or the **REST API**. They start as *Connected, not authorized*.
   - A person approves a scoped delegation, and the organization's key signs it, bound to that agent's key.
2. **Both agents sign.**
   - The seller's agent signs an offer: a quote or invoice over the canonical terms hash.
   - The buyer's agent signs an acceptance of the same hash.
   - Each answers a single-use challenge with its own key.
3. **ProxyProof decides.**
   - It verifies each side's identity, organization, delegation, expiry, revocation, scope, counterparty and (for the seller) payment destination.
   - It then matches the two signatures and applies a deterministic policy: **ALLOW**, **HOLD**, **REVIEW** or **DENY**, with exact reason codes.
4. **Protected execution.**
   - ALLOW issues a single-use, five-minute permit for those exact terms.
   - The executor verifies it, re-verifies both sides on live state, and creates a **PayPal Orders v2** sandbox checkout.
   - The buyer approves on PayPal. The state becomes **COMPLETED** only when PayPal confirms the capture.
5. **Evidence.**
   - A signed bundle links both authority chains, the match, the decision, permits and the provider outcome.
   - Anyone can verify it against `/.well-known/jwks.json`.

## Run it

Requires Node 24.

```bash
npm install
```

```bash
npm run build && npm start
```

Open http://localhost:8787:
- **Explore Live Demo** opens the **scenario lab**: 12 real-world scenarios (payout redirection, altered invoices, forged mandates, lookalike suppliers, prompt-injected agents, revoked agents, duplicate payments and more), each played in a fresh world through ProxyProof's real checks. See [docs/scenarios/real-world-scenarios.md](docs/scenarios/real-world-scenarios.md) for the scenarios and their sources.
- **Console** (from the lab) is the hands-on dashboard: connect your own agents, approve delegations, run single steps.
- **Explore the Architecture** opens the architecture explorer.

To enable the PayPal sandbox, copy `.env.example` to `.env` and set:
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_SANDBOX_RECEIVER_EMAIL` (the sandbox buyer)
- `PAYPAL_SANDBOX_MERCHANT_EMAIL`

**Connect Claude Code** (tested live on localhost):
1. In the dashboard, choose **Connect an agent**, then **Claude Code**.
2. Run the command it shows:

```bash
claude mcp add --transport http proxyproof http://localhost:8787/mcp --header "Authorization: Bearer ppc_…"
```

## Test it

```bash
npm test
```

There are 44 tests, all offline, using a loopback PayPal mock. They cover:
- every scenario in the lab, played through the real verification
- the bilateral scenarios
- the execution boundary: bypass, single use, time-of-use revocation, concurrency and capture
- evidence-bundle tamper detection
- the MCP connector, using the official MCP client
- an independently written REST agent
- architecture boundaries

```bash
npm run test:report
```

This regenerates `docs/testing/test-report.json`, which the explorer displays, with measured latency.

## Documentation

**Research**
- [Competitive landscape](docs/research/competitive-landscape.md)
- [Protocol compatibility](docs/research/protocol-compatibility.md)
- [Standards status](docs/research/standards-status.md)

**Architecture**
- [Bilateral model](docs/architecture/bilateral-commerce-model.md)
- [Execution boundary](docs/architecture/execution-boundary.md)
- [Security model](docs/architecture/security-model.md)
- [Threat model](docs/architecture/threat-model.md)
- [Connector API](docs/architecture/connector-api.md)

**Testing, demo and decisions**
- [Adversarial test results](docs/testing/adversarial-test-results.md)
- [Judge demo script](docs/demo/judge-demo-script.md)
- [Architecture decisions](docs/decisions/architecture-decisions.md)

## Stack

| Part | Technology |
|---|---|
| Server | Node 24, Hono, `node:sqlite`, Zod |
| Cryptography | `jose` and Node `crypto` (Ed25519) |
| MCP | MCP TypeScript SDK v2, spec 2026-07-28 |
| Web | React 19 and Vite |
| Payments | PayPal sandbox Orders v2 |

## Honest limits

- **Standards:** no conformance to AP2, VC, Verifiable Intent, AuthZEN or MCP OAuth is claimed. The delegation format is a ProxyProof profile.
- **Demo setup:** organization enrollment and key custody are demo-grade, and one person acts for every organization.
- **MCP assurance:** connections use a bearer token, recorded as lower assurance than an agent-held key.
- **Not yet built:** sub-delegation chain verification, an AP2 adapter, an AuthZEN interface, and OAuth for MCP.
- **Scope of enforcement:** ProxyProof cannot block an agent's other tools, and cannot stop misuse within a valid delegation.

## License

MIT
