# PayeeProof

**A security harness for human-authorized and AI-initiated payments.** Before an AI agent or a person can pay, PayeeProof verifies the payee, investigates the request, checks authorization and enforces a decision. It sits between a payment request and the money. It reads the invoice and email, checks who is asking and who would get paid against your own trusted records, and lets deterministic code decide whether this exact transaction may proceed. Held and denied payments cannot reach the payment executor, which is the only component holding PayPal credentials.

> Independent hackathon project for the PayPal AI Hackathon. Not affiliated with, endorsed by or certified by PayPal. Payments run in the PayPal sandbox only.

## What it does

Every payment request, whether a person uploads an invoice or an AI agent submits a signed request, goes through one pipeline:

1. **Ingest.** PDF, PNG/JPG and `.eml` files are identified by content, hashed, and size and page limited. PDFs are read from their text layer, images with local OCR (Tesseract, bundled language data), and emails with their attachments.
2. **Extract.** A deterministic parser reads labelled fields with per-field confidence and source line. Missing fields stay `UNKNOWN`, and contradictions are flagged as `CONFLICT`, never guessed. When an Anthropic key is set, Claude reads the document independently. If the parser and Claude disagree on a field, it becomes a conflict.
3. **Investigate.** The request is compared with the trusted vendor registry, verified destinations, invoice history, earlier payments, the email sender and reply-to, Authentication-Results, invoice arithmetic, duplicates, and public DNS and RDAP records. Every evidence item records its source, time, provenance, reliability and limitations.
4. **Decide.** A pure, unit-tested policy engine with 56 rules returns `ALLOW`, `REVIEW`, `HOLD` or `DENY` with machine-readable reasons. AI output can only raise a decision to `REVIEW`. It can never lower one.
5. **Approve.** `REVIEW` needs a person, bound to the transaction fingerprint, amount, destination, invoice fingerprint and policy version. Any material change voids the approval.
6. **Execute.** The gate checks the HMAC-signed decision, then runs the policy again on live data and atomically claims the payment once before calling the PayPal sandbox (Payouts, or Orders with buyer approval).
7. **Confirm.** A payment is marked complete only after an authenticated PayPal API lookup or a webhook verified by PayPal's signature service.
8. **Record.** Every step is appended to a SHA-256 hash-chained audit ledger. The database rejects updates and deletes, and the chain detects tampering that bypasses that.

## The product

| Section | What it is for |
| --- | --- |
| **Overview** | Status of every request (Allowed, Under review, Held, Denied, Completed), the transaction activity with the reason for each decision, payee verification, security insights and agents. All numbers are computed from stored records. |
| **Transactions** | The full list with filters, uploads, and an investigation page for each request: what was requested, who asked, who would be paid, the verification checklist, rules fired, evidence, the payment path and whether money moved. |
| **Payees** | Business identity and payment destinations, verified separately. Destination change requests wait here for independent verification. |
| **AI Agents** | Registered agents, their scoped authorizations, and revocation. |
| **Policies** | Thresholds and actions, versioned. Hard stops cannot be turned off. |
| **Security Testing** | Upload genuine or malicious invoices, send signed agent requests with manipulations, try to force blocked payments through the gate, and run the 29-scenario suite. |
| **Settings** | PayPal sandbox, model and agent endpoint status, and the hash-chained audit ledger. |

*Allowed* means the policy permits a payment. *Completed* means PayPal confirmed it. The two are never conflated. A new demo workspace includes ten sample requests, each submitted through the real pipeline when the workspace is created. They carry a *Sample* tag, and none is paid. Set `DEMO_SAMPLES=off` to start empty.

The PayeeProof monogram is an original mark: two linked P forms with a verification seal. PayPal appears only as the named payment provider. No PayPal logo or brand asset is used.

## Run it

Requirements: Node.js 22.5 or later (24 recommended). No database server is needed: PayeeProof uses Node's built-in SQLite.

```bash
npm install
npm run build
npm start
```

Open http://localhost:8787 and choose **Open a demo workspace**. Without any configuration, everything works except real sandbox payments and Claude.

To enable sandbox payments and AI, copy `.env.example` to `.env` and fill in:

| Variable | Needed for |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal developer **sandbox** app (Merchant). Payouts must be enabled. |
| `PAYPAL_SANDBOX_RECEIVER_EMAIL` | The sandbox personal account that the demo vendor is paid at |
| `PAYPAL_WEBHOOK_ID` | Webhook verification. Without it, all webhooks are rejected. |
| `ANTHROPIC_API_KEY` | Optional. Claude extraction and investigator notes (`claude-opus-5-5`). |
| `SERVER_SECRET` | Set in production. Signs policy decisions. |

### Tests

```bash
npm test               # 57 offline tests, including all 29 challenge scenarios and the executor bypass suite
npm run typecheck
npm run sandbox:check  # Real PayPal sandbox: pays one permitted invoice, proves held ones are refused
```

`node --import tsx scripts/agent-client.ts` runs an external agent that holds its own Ed25519 key against a running server.

### Deploy

`Dockerfile` and `render.yaml` are included. Set `PUBLIC_URL` to the public HTTPS address, register the webhook with `node --env-file=.env --import tsx scripts/register-webhook.ts https://HOST/api/paypal/webhooks`, and put the returned ID in `PAYPAL_WEBHOOK_ID`. On a host without a persistent disk, the SQLite database resets on restart. Demo workspaces are created on demand, so judges are not affected.

## Judges

See [docs/JUDGES.md](docs/JUDGES.md) for a 5-minute test plan. See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and test results, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## What is real and what is simulated

| Real | Simulated or limited |
| --- | --- |
| PayPal sandbox Payouts, Orders create and capture, status lookup and webhook signature verification | Demo vendors, history and agents are fictional and seeded |
| Policy engine, gate, approvals, hash-chained ledger, Ed25519 agent signatures and EdDSA authorization grants | The in-app agent simulator signs with a key the server keeps for the demo. Real agents keep their own key (`scripts/agent-client.ts`). |
| PDF, OCR and email extraction, and DNS, DMARC and RDAP lookups | Seeded challenge scenarios turn public lookups and the model off, for reproducibility |
| Claude extraction and investigator notes, when `ANTHROPIC_API_KEY` is set | Authorizations are PayeeProof's own scoped grants, not AP2 mandates |

## Stack

TypeScript throughout. Hono on Node 24, `node:sqlite`, Zod, pdf.js, Tesseract.js, mailparser, jose, and the Anthropic SDK. React 19 with Vite for the UI, and Vitest for tests. One process, one database file.

## License

MIT
