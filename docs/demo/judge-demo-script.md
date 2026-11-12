# Judge demo script (about 3 minutes)

**Goal:**
- Understand the product in 10 seconds.
- Understand the architecture in 2 minutes.
- See one working end-to-end transaction and one blocked attack.

## 0:00 Landing (10 seconds)
- The hero is split diagonally into two worlds: **Claimed.** (an agent's word) and **Proven.** (what ProxyProof checks).
- Below them, one illustrative $240 payment plays out:
  1. The paying agent's request is held at the ProxyProof boundary.
  2. Identity is checked, then the payer's mandate (its card turns the first green).
  3. Then the recipient's delegation (its card turns the second green).
  4. ProxyProof matches the terms and account, and decides Allow with a single-use permit.
  5. The PayPal sandbox checkout completes, and the whole hero turns green.
- **Replay the payment** runs it again.
- Further down, "How one payment gets proven" carries the MAKE / COLLECT question and the six steps, each with the reason codes that stop a payment.

## 0:10 Explore the Architecture (about 40 seconds)
- **End-to-end flow:** each stage shows what already exists, what ProxyProof adds, why it matters, the test that proves it, and what is not implemented.
- **Existing ecosystem:** AP2, PayPal Orders, Agent Toolkit, Agent Ready, ACP, UCP, Visa TAP, Verifiable Intent, AuthZEN, EMILIA, and Open Agent Commerce. Each is credited, and none is claimed as ProxyProof's own.
- **Measured results:** taken from the last test run (30 of 30 passed), with p50 and p95 verification latency.

## 0:50 Live dashboard: buyer view (about 40 seconds)
1. Choose **Explore Live Demo**. Each judge gets an isolated workspace.
2. **BUYER VIEW** asks "Is this AI agent authorized to COLLECT payment?"
3. Run **scenario 1, Both sides valid**:
   - The seller's agent sends an invoice. Its nine checks pass.
   - The buyer's agent signs acceptance of the same terms hash. Its checks and the match pass.
   - The decision is **ALLOW**, and a single-use permit is issued.
   - The executor admits the permit and creates a real **PayPal sandbox order**, shown as "Awaiting buyer on PayPal".
4. Choose **Inspect bilateral evidence**:
   - The bundle shows both chains, every check, the decision, the permit and the PayPal order.
   - **Verify bundle** shows that it is valid.
   - **Verify a tampered copy** shows that the digest does not match.

## 1:30 Seller view and an attack (about 50 seconds)
1. Switch to **SELLER VIEW**. The question changes to MAKE, and the buyer's agent is now the one under scrutiny.
2. **Scenario 4 (Same owner, research-only agent):** the agent belongs to the same organization, but the buyer side fails with `ACTION_NOT_PERMITTED`. Owning an agent does not give it authority.
3. **Scenario 5 (Terms changed after approval):**
   - The seller's agent revises the invoice after the buyer approved it.
   - The decision goes back to HOLD, and re-using the old permit is refused with **`TERMS_CHANGED`**.
4. **Scenario 2 (Seller agent not authorized to invoice):** the buyer sees "This is not a verified seller request".

## 2:20 Revoke, and complete the payment (about 40 seconds)
1. Open **Agents** and **Revoke** the Harbor & Pine Sales Agent.
2. Run scenario 1 again. The seller side now fails with `DELEGATION_REVOKED`.
3. To complete the earlier transaction: **Approve as the buyer on PayPal**, sign in as the sandbox buyer and approve, then choose **Capture after approval**. The state becomes **Paid (PayPal confirmed)** only after PayPal confirms it.

## Optional: a genuine external agent (Claude Code over MCP)
1. Choose **Connect an agent**, select **Claude Code**, name it, and choose Northwind Hotels as the buyer.
2. Run the shown `claude mcp add` command in a terminal. The agent now appears as **Connected, not authorized**.
3. In Claude Code, ask: "Use ProxyProof to check my status." It reports **CONNECTED**.
4. Ask it to request authority to purchase coffee up to $300. In the dashboard, choose **Approve as Northwind Hotels**. The agent is now **AUTHORIZED**.
5. Run scenario 1's seller step, or ask the seller agent to send an invoice. Then ask Claude Code to review and accept the transaction. The dashboard shows the decision made by the real backend.
6. Revoke the agent and ask again. The request is refused with the exact reason.

## What a judge can inspect
- Both organizations and both agents, including provider, connection and assurance.
- The authority evidence: credentials, signed requests and each check.
- The exact terms and terms hash.
- The decision and its reasons.
- Whether the executor was called.
- The PayPal sandbox reference and state.
- The signed evidence bundle.
