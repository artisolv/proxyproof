# Real-world scenarios

The scenario lab is the dashboard at `/app`. It plays one scenario at a time through ProxyProof's real verification:
- Each run builds a fresh, isolated world: two businesses, their agents, keys and delegations.
- The agents act through the public agent API.
- Every colour and every outcome on screen is what verification returned.

**How a scenario is defined.** A scenario only sets up conditions and tells each agent what to attempt. Examples:
- an agent's delegation is revoked
- the invoice's payout account is changed
- the terms are altered in transit

No outcome is keyed to a scenario: the engine never reads what a scenario "should" do. The expected results live only in `server/test/lab.test.ts`, so a regression in the trust layer shows up as a changed decision.

## How the lab is laid out

Each run combines one **request** with one **complication**. The left agent is given one of three requests:
- Order this week's coffee: a quote for $238
- Pay the monthly supply bill: $476, above Northwind's $250 approval line
- Pay Tuesday's machine service invoice: $240

The complication is what goes wrong this time.

The screen has three columns:

| Column | What it shows |
|---|---|
| Left | Buyer's agent, in violet |
| Centre | The order, bill or service as a sliding banner, with ProxyProof's verdict card below it |
| Right | Seller's agent, in plum |

**The verdict card** is green while checks pass and orange when a payment is held. It turns the buyer manager's purple while a person must approve.

**Manager approval.** When ProxyProof asks for review, the run genuinely waits. The presenter's click performs the signed approval (`POST /api/lab/runs/:id/approve`).

**The step rail** runs along the bottom as one connected track. Each step is drawn in its actor's colour:

| Actor | Colour |
|---|---|
| Buyer's agent | Violet |
| Northwind manager | Deep purple |
| Seller's agent | Plum |
| ProxyProof | Dusk |
| PayPal | Blue |
| Outside events | Grey |

**Coverage.** All 32 request × complication combinations are pinned in `server/test/lab.test.ts`.

## The world

Northwind Hotels buys roasted coffee every week for its breakfast rooms from its usual roaster, Harbor & Pine Roasters. Both businesses let AI agents handle the order and the invoice.

| Agent | Acts for | Authority signed by its organization |
|---|---|---|
| Northwind Procurement Agent | Northwind Hotels | Purchase coffee only, up to $500, from Harbor & Pine. Above $250 a person approves the exact terms. |
| Harbor & Pine Sales Agent | Harbor & Pine Roasters | Quote and invoice coffee and equipment, up to $2,000, to Northwind. Payment only to the account Harbor & Pine enrolled. |
| Bayside Sales Agent | Bayside Trading Co. (not enrolled) | Its own delegation, but its business never completed enrollment. |

**Products:**
- House Blend 5 lb: $66
- Espresso Roast 5 lb: $70
- Decaf Blend 2 lb: $36
- Countertop espresso grinder (equipment): $395

**The usual weekly invoice:** $238.

## Scenarios, in demo order

| # | Scenario | What is different | Caught by | Real-world pattern |
|---|---|---|---|---|
| 1 | Weekly coffee order | Nothing | Allow, permit, PayPal sandbox checkout | Google's AP2 asks for signed proof of an agent's authority for a specific purchase |
| 2 | Bigger order, human approves | $476, above the $250 line | `REVIEW_REQUIRED`. A Northwind manager approves the exact terms with Northwind's key, then Allow | An agent bought $31 of eggs without asking (Washington Post, 2025) |
| 3 | Payout account quietly changed | Invoice pays a lookalike account | Seller side: `DESTINATION_NOT_AUTHORIZED` at the offer | Business email compromise: $2.77B in 2024 (FBI IC3) |
| 4 | Invoice changed after signing | One line raised by $100 in transit | Match: `TERMS_MODIFIED` | Europol: genuine invoices with altered details |
| 5 | Agents disagree on the price | Buyer's agent signs a total $50 lower | Match: `TERMS_MISMATCH` | Microsoft Research Magentic Marketplace: agents manipulated by seller agents |
| 6 | Forged buyer mandate | Mandate claims Northwind but is signed by another key | Buyer side: `DELEGATION_FORGED` | Arup: $25M sent after a deepfake "CFO" call |
| 7 | Lookalike supplier | An unenrolled seller invoices Northwind | Hold `ORG_NOT_ESTABLISHED`, then buyer side `COUNTERPARTY_NOT_APPROVED` | DOJ: a company registered under a real supplier's name diverted over $120M |
| 8 | Hijacked agent buys a grinder | Prompt-injected agent tries to buy equipment | Buyer side: `CATEGORY_NOT_PERMITTED` | Brave: hidden page text hijacked an AI browser agent |
| 9 | Agent revoked, permit in hand | Mandate revoked after the permit was issued | Executor: `LIVE_RECHECK_FAILED`. The permit is consumed and PayPal is never called | DOJ: a former Cisco engineer's access still worked 5 months after he left |
| 10 | Same permit, second payment | The permit is sent twice | Executor: `PERMIT_ALREADY_USED`, before PayPal is called | Citibank's mistaken $900M wire took two years to recover |
| 11 | Revocation check unreachable | Status service down at acceptance | Hold `STATUS_UNAVAILABLE`. Once the service is back, a recheck allows the payment | Chrome's security lead on soft-fail revocation checks |
| 12 | Authorized, but the wrong roast | Wrong item, but inside the mandate | Nothing: Allow. This is an honest limit | Anthropic Project Vend: agents misbehave inside their permissions too |

## Honest limits

**Scenario 12 is deliberate.** ProxyProof answers "was this authorized?", not "was this wise?". Tightening the mandate is the organization's policy.

**It cannot control an agent's other tools.**

**MCP connections are lower assurance.** A connection reached with a stolen bearer token is weaker than a request signed with the agent's own key.

## Sources

Fable researched these (Claude Fable 5.1) and the claims below were checked against the pages. Where a detail comes from press rather than the primary source, it is noted.

| # | What it shows | Source |
|---|---|---|
| 1 | BEC losses of $2.77B in 2024. The FBI advises verifying changes to payment details through a second channel. | [FBI IC3 2024 report](https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf), [PSA 240911](https://www.ic3.gov/PSA/2024/PSA240911) |
| 2 | Arup: about US$25M sent after a deepfake video call | [CFO Dive](https://www.cfodive.com/news/deepfake-scam-engineering-firm-arup-25-million-fraud-hong-kong-cfo/716501/) |
| 3 | Supplier impersonation that diverted over $120M. The victims are named by the press, not by the DOJ. | [US DOJ SDNY](https://www.justice.gov/usao-sdny/pr/lithuanian-man-sentenced-5-years-prison-theft-over-120-million-fraudulent-business) |
| 4 | Invoice fraud with altered bank details | [Europol](https://www.europol.europa.eu/sites/default/files/documents/6_invoice_fraud.pdf) |
| 5 | A shopping agent bought eggs without confirmation and misreported the total | [Washington Post, syndicated by ADN](https://www.adn.com/alaska-life/2025/02/09/i-let-chatgpts-new-agent-manage-my-life-it-spent-31-on-a-dozen-eggs/) |
| 6 | Project Vend: discounts were talked out of the agent, and it invented a payment account | [Anthropic](https://www.anthropic.com/research/project-vend-1) |
| 7 | Prompt injection against browser agents | [Brave](https://brave.com/blog/comet-prompt-injection/), [Anthropic](https://claude.com/blog/claude-for-chrome) |
| 8 | Agents manipulated in a simulated marketplace. Model-by-model results come from the press. | [Microsoft Research](https://www.microsoft.com/en-us/research/publication/magentic-marketplace-an-open-source-environment-for-studying-agentic-markets/) |
| 9 | Access that still worked after an employee left | [US DOJ NDCA](https://www.justice.gov/usao-ndca/pr/san-jose-man-sentenced-two-years-imprisonment-damaging-cisco-s-network) |
| 10 | Citi and Revlon: a mistaken $900M payment | [Banking Dive](https://www.bankingdive.com/news/citi-revlon-lawsuit-payment-mistake-creditors/595154/) |
| 11 | Why soft-fail revocation checks are unsafe | [Adam Langley](https://www.imperialviolet.org/2012/02/05/crlsets.html) |
| 12 | AP2 and PayPal on signed mandates | [Google Cloud](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol), [PayPal Developer](https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/) |
| 13 | Visa Trusted Agent Protocol verifies the buyer's agent to the merchant | [Visa](https://www.visa.com/en-ua/newsroom/visa-trusted-agent-protocol) |
| 14 | Mastercard Agent Pay: registered, verified agents, including for B2B sourcing | [Mastercard](https://newsroom.mastercard.com/news/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai) |

## Engine and agent drivers

| File | Purpose |
|---|---|
| `server/src/scenarios/catalog.ts` | The world and the scenarios: conditions and agent instructions only |
| `server/src/scenarios/engine.ts` | Builds each run's isolated world, plays the steps, records a snapshot after every step, and stores the run |
| `server/src/scenarios/drivers.ts` | How the engine talks to an agent |

**Drivers.** `TestRuntimeDriver` is a labelled test agent whose key ProxyProof holds. It can apply an attack technique to a genuine request.

`ExternalAgentDriver` is the contract for real agents behind their own API:

```
POST {agent_url}/proxyproof/offer    { workspace, draft, buyer_org_id, transaction_id? }
POST {agent_url}/proxyproof/accept   { workspace, transaction_id }
```

The agent signs with its own key, calls ProxyProof's public agent API itself, and returns ProxyProof's response. Until an agent's URL is configured, this driver refuses rather than pretending.

**Routes:**
- `GET /api/lab/scenarios`
- `POST /api/lab/runs { prompt, complication }`
- `POST /api/lab/runs/:id/approve` (the buyer manager's signed approval, when ProxyProof asked for review)
- `GET /api/lab/runs/:id` (add `?sync=1` to refresh the PayPal state)
- `POST /api/lab/runs/:id/capture`

Runs are private to the workspace that started them.
